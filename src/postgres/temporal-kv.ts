import { StorageError, ValidationError } from "../interfaces/storage-errors.js";
import {
  ExpectedVersionSchema,
  HistoryUnavailableError,
  JsonValueSchema,
  KeySchema,
  NamespaceSchema,
  ScopeSchema,
  VersionConflictError,
  VersionedEntrySchema,
  type AsOf,
  type JsonValue,
  type Key,
  type Namespace,
  type Scope,
  type TemporalKV,
  type Version,
  type VersionedEntry,
} from "../interfaces/temporal-kv.js";
import type { TransactionHandle } from "../interfaces/transaction-lease.js";
import { DEFAULT_SCHEMA, type UmbraDBSql } from "./client.js";
import { translatePostgresError } from "./errors.js";

/**
 * Thrown by every `PgTemporalKV` method when a caller passes `opts.tx` — transaction
 * participation wiring is deferred until the Transaction/Lease module exists (a later sprint),
 * per `openspec/changes/sprint-1-setup-and-temporal-kv/design.md` §4. Silently accepting and
 * ignoring `opts.tx` would run the operation outside the caller's intended transaction, a
 * silent atomicity loss — this makes the gap loud instead. Thrown before any query runs.
 */
export class TransactionParticipationNotSupportedError extends StorageError {
  readonly code = "TRANSACTION_NOT_SUPPORTED" as const;
  constructor(method: string) {
    super(`PgTemporalKV.${method}: opts.tx is not yet supported (Transaction/Lease module not wired this sprint)`);
  }
}

function assertNoTx(tx: TransactionHandle | undefined, method: string): void {
  if (tx !== undefined) throw new TransactionParticipationNotSupportedError(method);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}

/** Races `promise` against `signal`'s abort event. An abort observed after `promise` already
 *  settled is a no-op (matching every signal-bearing method's documented contract). */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

interface KvRow {
  value: JsonValue;
  version: bigint;
  written_at: Date;
}

function toEntry<T extends JsonValue>(ns: Namespace, scope: Scope, key: Key, row: KvRow): VersionedEntry<T> {
  const parsed = VersionedEntrySchema.safeParse({
    namespace: ns,
    scope,
    key,
    value: row.value,
    version: row.version,
    writtenAt: row.written_at,
  });
  if (!parsed.success) throw ValidationError.fromZod("PgTemporalKV row", parsed.error);
  return parsed.data as VersionedEntry<T>;
}

/** Escapes `%`, `_`, and `\` so a caller's `prefix` is matched literally by `LIKE ... ESCAPE
 *  '\'`, not interpreted as pattern syntax (design.md §4's `listKeys` fix). */
function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, "\\$&");
}

/**
 * Postgres/JSONB implementation of `TemporalKV` (`src/interfaces/temporal-kv.ts`), against the
 * `kv_current`/`kv_history` schema in `migrations/001_temporal_kv.ts`
 * (`openspec/changes/sprint-1-setup-and-temporal-kv/design.md` §2/§4). Does not run migrations
 * itself — call `runMigrations` (`migrate.ts`) before constructing this against a fresh
 * database. `opts.tx` is accepted (matching the interface) but rejected at runtime this sprint;
 * see `TransactionParticipationNotSupportedError`.
 */
export class PgTemporalKV implements TemporalKV {
  constructor(
    private readonly sql: UmbraDBSql,
    private readonly schema: string = DEFAULT_SCHEMA,
  ) {}

  private validateNamespaceScope(namespace: string, scope: string): void {
    const ns = NamespaceSchema.safeParse(namespace);
    if (!ns.success) throw ValidationError.fromZod("PgTemporalKV namespace", ns.error);
    const sc = ScopeSchema.safeParse(scope);
    if (!sc.success) throw ValidationError.fromZod("PgTemporalKV scope", sc.error);
  }

  private validateKey(namespace: string, scope: string, key: string): void {
    this.validateNamespaceScope(namespace, scope);
    const k = KeySchema.safeParse(key);
    if (!k.success) throw ValidationError.fromZod("PgTemporalKV key", k.error);
  }

  async put<T extends JsonValue>(
    namespace: Namespace, scope: Scope, key: Key, value: T,
    opts?: { expectedVersion?: Version; tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<VersionedEntry<T>> {
    assertNoTx(opts?.tx, "put");
    this.validateKey(namespace, scope, key);
    const valueCheck = JsonValueSchema.safeParse(value);
    if (!valueCheck.success) throw ValidationError.fromZod("PgTemporalKV value", valueCheck.error);
    if (opts?.expectedVersion !== undefined) {
      const evCheck = ExpectedVersionSchema.safeParse(opts.expectedVersion);
      if (!evCheck.success) throw ValidationError.fromZod("PgTemporalKV expectedVersion", evCheck.error);
    }

    return withAbort(this.putImpl<T>(namespace, scope, key, value, opts?.expectedVersion), opts?.signal);
  }

  private async putImpl<T extends JsonValue>(
    ns: Namespace, scope: Scope, key: Key, value: T, expectedVersion: Version | undefined,
  ): Promise<VersionedEntry<T>> {
    const sql = this.sql;
    const jsonValue = sql.json(value as JsonValue);

    try {
      if (expectedVersion === undefined) {
        // Case 1 (Law T1's "total" case): unconditional upsert, always succeeds.
        const rows = await sql<KvRow[]>`
          INSERT INTO ${sql(this.schema)}.kv_current (ns, scope, key, value, version)
          VALUES (${ns}, ${scope}, ${key}, ${jsonValue}, 1)
          ON CONFLICT (ns, scope, key) DO UPDATE
          SET value = EXCLUDED.value, version = ${sql(this.schema)}.kv_current.version + 1
          RETURNING value, version, updated_at AS written_at
        `;
        return toEntry<T>(ns, scope, key, rows[0]!);
      }

      if (expectedVersion === 0n) {
        // Case 2: "must not already exist" — DO NOTHING atomically handles create-only writes;
        // a plain guarded UPDATE cannot insert (design.md §4's CAS re-derivation table).
        const rows = await sql<KvRow[]>`
          INSERT INTO ${sql(this.schema)}.kv_current (ns, scope, key, value, version)
          VALUES (${ns}, ${scope}, ${key}, ${jsonValue}, 1)
          ON CONFLICT (ns, scope, key) DO NOTHING
          RETURNING value, version, updated_at AS written_at
        `;
        if (rows.length > 0) return toEntry<T>(ns, scope, key, rows[0]!);
        // Zero rows: the key already existed (that IS the conflict for expectedVersion=0n) —
        // re-read to report its real current version.
        const existing = await sql<KvRow[]>`
          SELECT value, version, updated_at AS written_at FROM ${sql(this.schema)}.kv_current
          WHERE ns = ${ns} AND scope = ${scope} AND key = ${key}
        `;
        throw new VersionConflictError(0n, existing[0]?.version);
      }

      // Case 3: CAS against a specific existing version — NOT INSERT ... ON CONFLICT, which
      // cannot express "fail if the row is absent" (would silently insert instead of failing).
      const rows = await sql<KvRow[]>`
        UPDATE ${sql(this.schema)}.kv_current
        SET value = ${jsonValue}, version = version + 1
        WHERE ns = ${ns} AND scope = ${scope} AND key = ${key} AND version = ${expectedVersion}
        RETURNING value, version, updated_at AS written_at
      `;
      if (rows.length > 0) return toEntry<T>(ns, scope, key, rows[0]!);
      // Zero rows affected is ambiguous between "conflict" (key exists at a different version)
      // and "key never written" — re-read to distinguish, per the interface's documented
      // contract (actual = undefined only in the never-written case).
      const existing = await sql<KvRow[]>`
        SELECT value, version, updated_at AS written_at FROM ${sql(this.schema)}.kv_current
        WHERE ns = ${ns} AND scope = ${scope} AND key = ${key}
      `;
      throw new VersionConflictError(expectedVersion, existing[0]?.version);
    } catch (err) {
      if (err instanceof VersionConflictError) throw err;
      throw translatePostgresError(err, { namespace: ns, scope, key });
    }
  }

  async get<T extends JsonValue = JsonValue>(
    namespace: Namespace, scope: Scope, key: Key,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<VersionedEntry<T> | null> {
    assertNoTx(opts?.tx, "get");
    this.validateKey(namespace, scope, key);
    return withAbort(this.getImpl<T>(namespace, scope, key), opts?.signal);
  }

  private async getImpl<T extends JsonValue>(ns: Namespace, scope: Scope, key: Key): Promise<VersionedEntry<T> | null> {
    try {
      const rows = await this.sql<KvRow[]>`
        SELECT value, version, updated_at AS written_at FROM ${this.sql(this.schema)}.kv_current
        WHERE ns = ${ns} AND scope = ${scope} AND key = ${key}
      `;
      return rows.length > 0 ? toEntry<T>(ns, scope, key, rows[0]!) : null;
    } catch (err) {
      throw translatePostgresError(err, { namespace: ns, scope, key });
    }
  }

  async getAt<T extends JsonValue = JsonValue>(
    namespace: Namespace, scope: Scope, key: Key, asOf: AsOf,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<VersionedEntry<T> | null> {
    assertNoTx(opts?.tx, "getAt");
    this.validateKey(namespace, scope, key);
    if (asOf.kind !== "version" && asOf.kind !== "at") {
      throw new ValidationError(
        "PgTemporalKV getAt: asOf must be {kind: 'version'} or {kind: 'at'}",
        [{ path: "asOf.kind", message: "invalid discriminant" }],
      );
    }
    return withAbort(this.getAtImpl<T>(namespace, scope, key, asOf), opts?.signal);
  }

  private async getAtImpl<T extends JsonValue>(
    ns: Namespace, scope: Scope, key: Key, asOf: AsOf,
  ): Promise<VersionedEntry<T> | null> {
    // Sprint 1 performs no history retention at all (design.md §2's explicit, narrower scope
    // decision) — HistoryUnavailableError's retention-floor check has nothing to check against
    // yet, so it cannot be thrown by this implementation. The import is kept (and re-exported
    // via the public interface) so a later sprint's retention mechanism can wire it in without
    // a breaking interface change.
    void HistoryUnavailableError;

    try {
      const rows = asOf.kind === "version"
        ? await this.sql<KvRow[]>`
            SELECT value, version, updated_at AS written_at FROM ${this.sql(this.schema)}.kv_current
            WHERE ns = ${ns} AND scope = ${scope} AND key = ${key} AND version = ${asOf.version}
            UNION ALL
            SELECT value, version, valid_from AS written_at FROM ${this.sql(this.schema)}.kv_history
            WHERE ns = ${ns} AND scope = ${scope} AND key = ${key} AND version = ${asOf.version}
            LIMIT 1
          `
        : await this.sql<KvRow[]>`
            SELECT value, version, valid_from AS written_at FROM ${this.sql(this.schema)}.kv_history
            WHERE ns = ${ns} AND scope = ${scope} AND key = ${key} AND validity @> ${asOf.at}::timestamptz
            UNION ALL
            SELECT value, version, updated_at AS written_at FROM ${this.sql(this.schema)}.kv_current
            WHERE ns = ${ns} AND scope = ${scope} AND key = ${key} AND updated_at <= ${asOf.at}::timestamptz
            LIMIT 1
          `;
      return rows.length > 0 ? toEntry<T>(ns, scope, key, rows[0]!) : null;
    } catch (err) {
      throw translatePostgresError(err, { namespace: ns, scope, key });
    }
  }

  async *listKeys(
    namespace: Namespace, scope: Scope, prefix: string,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): AsyncIterable<Key> {
    assertNoTx(opts?.tx, "listKeys");
    this.validateNamespaceScope(namespace, scope);
    const signal = opts?.signal;
    const escaped = escapeLikePrefix(prefix) + "%";

    const cursor = this.sql<{ key: string }[]>`
      SELECT key FROM ${this.sql(this.schema)}.kv_current
      WHERE ns = ${namespace} AND scope = ${scope} AND key LIKE ${escaped} ESCAPE '\\'
      ORDER BY key
    `.cursor(256);

    for await (const batch of cursor) {
      if (signal?.aborted) throw abortError(signal);
      for (const row of batch) {
        yield row.key;
        if (signal?.aborted) throw abortError(signal);
      }
    }
  }
}
