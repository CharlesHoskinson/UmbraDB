import type { ISql } from "postgres";
import { ValidationError } from "../interfaces/storage-errors.js";
import {
  ExpectedVersionSchema,
  HistoryUnavailableError,
  hasPostgresUnsafeText,
  JsonValueSchema,
  KeySchema,
  NamespaceSchema,
  ScopeSchema,
  StoredVersionSchema,
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
import { abortError, withAbort } from "./abort.js";
import type { UmbraDBSql } from "./client.js";
import { translatePostgresError } from "./errors.js";
import { resolveTransaction } from "./transaction-lease.js";

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
 * database. `opts.tx`, once resolved via `resolveTransaction`
 * (`openspec/changes/sprint-2-transaction-lease/design.md` §4), routes that method's queries
 * through the caller's own transaction-scoped connection instead of this instance's own `sql`.
 *
 * The `schema` constructor parameter defaults to `sql.umbradbSchema` — the schema
 * `createClient` actually configured this connection with (`client.ts`) — NOT an independent
 * literal default. **Fixed after a cross-vendor audit found the original independent default
 * (`"umbradb"`) meant `createClient({schema: "tenant_a"})` followed by `new PgTemporalKV(sql)`
 * (without ALSO re-passing `"tenant_a"` here) would silently query the wrong schema**, since
 * the two defaults previously had no relationship to each other at all. An explicit second
 * argument still overrides this default for a caller who genuinely wants an adapter pointed at
 * a different schema than the connection's own configured one.
 */
export class PgTemporalKV implements TemporalKV {
  constructor(
    private readonly sql: UmbraDBSql,
    private readonly schema: string = sql.umbradbSchema,
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
    const sql = opts?.tx !== undefined ? resolveTransaction(opts.tx) : this.sql;
    this.validateKey(namespace, scope, key);
    const valueCheck = JsonValueSchema.safeParse(value);
    if (!valueCheck.success) throw ValidationError.fromZod("PgTemporalKV value", valueCheck.error);
    if (opts?.expectedVersion !== undefined) {
      const evCheck = ExpectedVersionSchema.safeParse(opts.expectedVersion);
      if (!evCheck.success) throw ValidationError.fromZod("PgTemporalKV expectedVersion", evCheck.error);
    }

    return withAbort(() => this.putImpl<T>(sql, namespace, scope, key, value, opts?.expectedVersion), opts?.signal);
  }

  private async putImpl<T extends JsonValue>(
    sql: ISql<{ bigint: bigint }>, ns: Namespace, scope: Scope, key: Key, value: T, expectedVersion: Version | undefined,
  ): Promise<VersionedEntry<T>> {
    const jsonValue = sql.json(value as JsonValue);

    try {
      if (expectedVersion === undefined) {
        // Case 1 (Law T1's "total" case): unconditional upsert -- always succeeds UNLESS this
        // write's truncated clock_timestamp() collides with a prior write to the same key
        // within the same millisecond, which raises ClockRegressionError (see that class's own
        // doc; found overstated by a fourth-round cross-vendor re-audit).
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
    const sql = opts?.tx !== undefined ? resolveTransaction(opts.tx) : this.sql;
    this.validateKey(namespace, scope, key);
    return withAbort(() => this.getImpl<T>(sql, namespace, scope, key), opts?.signal);
  }

  private async getImpl<T extends JsonValue>(
    sql: ISql<{ bigint: bigint }>, ns: Namespace, scope: Scope, key: Key,
  ): Promise<VersionedEntry<T> | null> {
    try {
      const rows = await sql<KvRow[]>`
        SELECT value, version, updated_at AS written_at FROM ${sql(this.schema)}.kv_current
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
    const sql = opts?.tx !== undefined ? resolveTransaction(opts.tx) : this.sql;
    this.validateKey(namespace, scope, key);
    // Revised after a cross-vendor audit: the discriminant was validated but its payload
    // wasn't — {kind:"version", version:-1n} previously reached SQL and just returned null
    // instead of ValidationError, and a malformed/invalid Date reached the driver raw.
    if (asOf.kind === "version") {
      const vCheck = StoredVersionSchema.safeParse(asOf.version);
      if (!vCheck.success) throw ValidationError.fromZod("PgTemporalKV getAt asOf.version", vCheck.error);
    } else if (asOf.kind === "at") {
      if (!(asOf.at instanceof Date) || Number.isNaN(asOf.at.getTime())) {
        throw new ValidationError(
          "PgTemporalKV getAt: asOf.at must be a valid Date",
          [{ path: "asOf.at", message: "missing, not a Date, or an invalid Date" }],
        );
      }
    } else {
      throw new ValidationError(
        "PgTemporalKV getAt: asOf must be {kind: 'version'} or {kind: 'at'}",
        [{ path: "asOf.kind", message: "invalid discriminant" }],
      );
    }
    return withAbort(() => this.getAtImpl<T>(sql, namespace, scope, key, asOf), opts?.signal);
  }

  private async getAtImpl<T extends JsonValue>(
    sql: ISql<{ bigint: bigint }>, ns: Namespace, scope: Scope, key: Key, asOf: AsOf,
  ): Promise<VersionedEntry<T> | null> {
    // Sprint 1 performs no history retention at all (design.md §2's explicit, narrower scope
    // decision) — HistoryUnavailableError's retention-floor check has nothing to check against
    // yet, so it cannot be thrown by this implementation. The import is kept (and re-exported
    // via the public interface) so a later sprint's retention mechanism can wire it in without
    // a breaking interface change.
    void HistoryUnavailableError;

    // Both branches below tag their rows with a `priority` column and ORDER BY it before
    // LIMIT 1 — defense-in-depth added after a cross-vendor audit found the "at most one row
    // can ever match" argument rests entirely on trigger discipline (CALLER-ENFORCED, per
    // Formal/STORAGE_ALGEBRA.md's terminology), not a database constraint that spans
    // kv_history and kv_current together: the EXCLUDE constraint only forbids overlaps WITHIN
    // kv_history, so a manual/backfill kv_history row whose interval improperly covers the
    // live kv_current row's instant would make both halves of the UNION match, and an
    // unordered LIMIT 1 would then return an arbitrary one. Ordering makes that outcome
    // deterministic (kv_history wins, since it's the actual historical record) rather than
    // implementation-defined, without changing anything about the normal, non-corrupted case.
    try {
      const rows = asOf.kind === "version"
        ? await sql<KvRow[]>`
            SELECT value, version, valid_from AS written_at, 0 AS priority FROM ${sql(this.schema)}.kv_history
            WHERE ns = ${ns} AND scope = ${scope} AND key = ${key} AND version = ${asOf.version}
            UNION ALL
            SELECT value, version, updated_at AS written_at, 1 AS priority FROM ${sql(this.schema)}.kv_current
            WHERE ns = ${ns} AND scope = ${scope} AND key = ${key} AND version = ${asOf.version}
            ORDER BY priority
            LIMIT 1
          `
        : await sql<KvRow[]>`
            SELECT value, version, valid_from AS written_at, 0 AS priority FROM ${sql(this.schema)}.kv_history
            WHERE ns = ${ns} AND scope = ${scope} AND key = ${key} AND validity @> ${asOf.at}::timestamptz
            UNION ALL
            SELECT value, version, updated_at AS written_at, 1 AS priority FROM ${sql(this.schema)}.kv_current
            WHERE ns = ${ns} AND scope = ${scope} AND key = ${key} AND updated_at <= ${asOf.at}::timestamptz
            ORDER BY priority
            LIMIT 1
          `;
      return rows.length > 0 ? toEntry<T>(ns, scope, key, rows[0]!) : null;
    } catch (err) {
      throw translatePostgresError(err, { namespace: ns, scope, key });
    }
  }

  /**
   * **Revised after a cross-vendor audit found the original abort handling only reactive, not
   * responsive**: checking `signal.aborted` between already-arrived batches and after a
   * resumed `yield` does nothing for an abort that fires WHILE a batch fetch is genuinely
   * blocked (waiting on the network/server) — the loop is simply not running any code at that
   * moment to notice. This version races each `iterator.next()` call itself against the abort
   * event, so a blocked fetch is abandoned the moment abort fires, not only after the next
   * batch happens to arrive anyway. The per-row check before each `yield` is kept for the case
   * where a signal aborts while a batch's rows are being yielded one at a time.
   *
   * **Revised AGAIN after a follow-up cross-vendor re-audit found `iterator.return()` alone
   * does not actually stop a blocked fetch, verified against the installed `postgres.js`
   * source (`node_modules/postgres/src/query.js`):** the cursor's `return()` implementation
   * only signals anything via a `prev` resolver that is set INSIDE the callback fired when a
   * batch arrives — before the first batch ever arrives, `prev` is still unset, so `return()`
   * is a silent no-op. Calling only `iterator.return()` on abort therefore left a genuinely
   * blocked first-batch fetch running server-side indefinitely, with the connection never
   * cleanly freed. Fix: keep a reference to the underlying `Query` object (`query`, below,
   * captured BEFORE calling `.cursor()` on it) and call its own `query.cancel()` — a real,
   * documented Postgres-protocol query cancellation, not dependent on any batch having arrived
   * — from the abort listener itself, in addition to (not instead of) the existing
   * `iterator.return()` in `finally`, which still matters for the case where a batch already
   * arrived and the cursor is mid-stream.
   *
   * One residual, structural limitation this cannot fully close: if the CONSUMER stops calling
   * `.next()` on this generator entirely (neither continuing iteration nor explicitly calling
   * `.return()`/`break`) and then aborts, this generator's own body is suspended at `yield` and
   * simply isn't running any code to notice — no async generator can be "pushed" from outside
   * without the consumer resuming it. A consumer that wants prompt cleanup on abort in that
   * exact scenario must call `.return()` on the iterator itself (which a `for await...of` loop
   * does automatically via `break`); this is a standard, accepted limit of the async-iterator
   * protocol, not something specific to this method.
   */
  async *listKeys(
    namespace: Namespace, scope: Scope, prefix: string,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): AsyncIterable<Key> {
    const sql = opts?.tx !== undefined ? resolveTransaction(opts.tx) : this.sql;
    this.validateNamespaceScope(namespace, scope);
    // Found missing by a follow-up cross-vendor re-audit: prefix has no dedicated Zod schema
    // of its own (it's a raw string, not a Namespace/Scope/Key/JsonValue), so the same
    // NUL/lone-surrogate check every other string input gets was previously skipped for it.
    if (hasPostgresUnsafeText(prefix)) {
      throw new ValidationError(
        "PgTemporalKV listKeys: prefix must not contain a NUL byte or an unpaired UTF-16 surrogate",
        [{ path: "prefix", message: "PostgreSQL cannot store either" }],
      );
    }
    const signal = opts?.signal;
    if (signal?.aborted) throw abortError(signal);
    const escaped = escapeLikePrefix(prefix) + "%";

    const query = sql<{ key: string }[]>`
      SELECT key FROM ${sql(this.schema)}.kv_current
      WHERE ns = ${namespace} AND scope = ${scope} AND key LIKE ${escaped} ESCAPE '\\'
      ORDER BY key
    `;
    const cursor = query.cursor(256);
    const iterator = cursor[Symbol.asyncIterator]();

    let onAbort: (() => void) | undefined;
    const abortedWhileWaiting = signal && new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        // Corrected by a fifth-round cross-vendor re-audit, which caught a mistake this file's
        // OWN fourth-round fix introduced: `Query.prototype.cancel()` (the method actually
        // called here) is NOT the same thing as the internal `cancel(query)` factory function
        // that postgres.js's connection layer uses to build `query.canceller` -- that internal
        // factory does return a real Promise, but `Query.prototype.cancel()` itself, verified
        // against the installed source (`node_modules/postgres/src/query.js`), is
        // `cancel() { return this.canceller && (this.canceller(this), this.canceller = null) }`.
        // The comma operator means this expression evaluates to `this.canceller = null` -- i.e.
        // `null` (or `false`, if already cancelled) -- NOT the internal promise, which is
        // invoked purely for its side effect and its own result silently discarded by
        // `Query.prototype.cancel()` itself. The previous `(query.cancel() as unknown as
        // Promise<void>).catch(() => {})` therefore called `.catch` on a literal `null` and
        // crashed with an uncaught `TypeError` the moment any abort actually reached a genuinely
        // blocked query -- confirmed by two real test failures in the same run this fix
        // addresses. There is no promise to catch: this call is synchronous and its cancellation
        // request is fired off internally with no result this method exposes to us.
        query.cancel();
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      while (true) {
        let next;
        try {
          next = abortedWhileWaiting
            ? await Promise.race([iterator.next(), abortedWhileWaiting])
            : await iterator.next();
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") throw err;
          // Corrected by the same fifth-round re-audit: once `query.cancel()` above actually
          // reaches the server (the very case this whole abort path exists to handle), the
          // ORIGINAL query's own promise -- the one `iterator.next()` is awaiting -- rejects
          // with a real Postgres error (SQLSTATE 57014, "canceling statement due to user
          // request"), not our synthetic `abortError`. Whether that real rejection or our
          // synthetic one "wins" `Promise.race` above is a genuine, unavoidable race against
          // real network I/O, not something callable order can fix -- so if the signal we
          // ourselves aborted is what's responsible, ANY error surfacing here while it is
          // aborted must be reported as the abort the caller actually asked for, not as
          // whatever driver error happened to arrive first.
          if (signal?.aborted) throw abortError(signal);
          throw translatePostgresError(err);
        }
        if (next.done) break;
        for (const row of next.value) {
          if (signal?.aborted) throw abortError(signal);
          yield row.key;
        }
      }
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      await iterator.return?.();
    }
  }
}
