import postgres, { type Sql } from "postgres";

/** The `Sql` type shape actually produced by `createClient` — includes the `bigint` type
 *  mapping (`postgres.BigInt`) configured below, so callers get real `bigint` in and out of
 *  tagged-template queries instead of the untyped `Sql<{}>` default (which rejects `bigint`
 *  query parameters at compile time and would otherwise force every consumer, including
 *  `PgTemporalKV`, to lose that type information at the createClient boundary). Also carries
 *  the resolved schema name as `umbradbSchema` — see that property's own doc below for why.
 */
export type UmbraDBSql = Sql<{ bigint: bigint }> & { readonly umbradbSchema: string };

/** Default schema — see `openspec/changes/sprint-1-setup-and-temporal-kv/design.md` §0: a
 *  library default, not a name UmbraDB itself is embedded under. */
export const DEFAULT_SCHEMA = "umbradb";

/**
 * Schema names must be safe to interpolate as SQL identifiers via `postgres.js`'s `sql(name)`
 * helper. `sql(name)` already quotes/escapes correctly regardless of content, so this regex is
 * defense-in-depth (a malformed config value fails fast with a clear message here, rather than
 * producing confusing downstream DDL) — see design.md §2.
 *
 * **Length bound added after a cross-vendor audit**: Postgres truncates identifiers longer
 * than 63 bytes (`NAMEDATALEN - 1`) rather than rejecting them, so two configured schema names
 * agreeing on their first 63 characters would silently address the SAME physical schema —
 * while this module's own `hashtext()`-based advisory-lock keys (`migrate.ts`) hash the FULL
 * string and would NOT collide, letting two "different" schemas' migrations run unlocked
 * against one physical schema at the same time. Rejecting anything over the limit here closes
 * that gap at the source rather than relying on every caller of `hashtext()` to know about it.
 */
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
const POSTGRES_MAX_IDENTIFIER_BYTES = 63;

export function assertValidSchemaName(schema: string): void {
  if (!SCHEMA_NAME_PATTERN.test(schema)) {
    throw new Error(`invalid schema name: ${JSON.stringify(schema)} (must match ${SCHEMA_NAME_PATTERN})`);
  }
  if (schema.length > POSTGRES_MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `invalid schema name: ${JSON.stringify(schema)} exceeds PostgreSQL's ${POSTGRES_MAX_IDENTIFIER_BYTES}-byte identifier limit`,
    );
  }
}

export interface UmbraDBConnectionOptions {
  /** A postgres:// connection string, or omit to use PG* environment variables (postgres.js default). */
  connectionString?: string;
  /** Schema to operate in and to set as this connection's search_path. Default: "umbradb". */
  schema?: string;
  /** Max pool size for the general-purpose pool. Omit to use postgres.js's own default (10) —
   *  do NOT pass this key through as `undefined`, which silently forces a 1-connection pool
   *  (design.md §3 — a real postgres.js `k in o` presence-check bug, not folklore). */
  maxConnections?: number;
  /** Connection (TCP handshake) timeout in seconds. Omit to use postgres.js's own default (30s)
   *  unchanged. Pass a smaller value to fail fast against a known-unreachable host instead of
   *  hanging on that 30s default — matters where a closed port does NOT promptly refuse (e.g.
   *  WSL2, where connecting to `127.0.0.1:<closed>` hangs rather than returning ECONNREFUSED),
   *  which is why several tests in this project pass a small value here explicitly.
   *  **Reverted (audit finding F2): this used to default to 10 when omitted** — two auditors
   *  flagged that as an undocumented production-behavior change from postgres.js's own default,
   *  since a legitimately slow (but eventually successful) serverless/TLS connect that completed
   *  in, say, 15s would previously have started failing at 10s for every caller who never opted
   *  into this option at all. Omitting this option now genuinely means "postgres.js's default,"
   *  not a silently different one. */
  connectTimeout?: number;
}

/**
 * Connection factory (design/design.md §3, corrected 2026-07-20 per that section's own
 * revision note for two real driver-config bugs): configures `search_path` to the target
 * schema and `types.bigint` so `version` columns round-trip as real JS `bigint`, matching
 * `src/interfaces/temporal-kv.ts`'s `StoredVersionSchema`.
 *
 * **Revised after a cross-vendor audit found the chosen schema wasn't actually threaded
 * anywhere a caller could read it back.** `PgTemporalKV` (and any future adapter module) takes
 * its own, independently-defaulted `schema` constructor parameter — nothing previously
 * connected "the schema `createClient` was configured with" to "the schema an adapter
 * constructed from that client's `Sql` instance defaults to," so `createClient({schema:
 * "tenant_a"})` followed by `new PgTemporalKV(sql)` (without ALSO re-passing `"tenant_a"` as a
 * second constructor argument) would silently query `"umbradb"` instead — two independent
 * defaults that only agreed by accident. Fix: attach the resolved schema onto the returned
 * `Sql` instance itself (as `umbradbSchema`, a plain non-enumerable property — `postgres.js`'s
 * `sql` value is a callable function, and functions are ordinary objects that can carry extra
 * properties) so it becomes the ONE place this information lives; every adapter's constructor
 * defaults its own `schema` parameter to `sql.umbradbSchema` instead of a separate literal.
 */
/**
 * `postgres.js`'s own `parseOptions` (verified against the installed source,
 * `node_modules/postgres/src/index.js`) builds its final `connection` object as
 * `{ application_name: ..., ...o.connection, ...queryStringParams }` — i.e. a connection
 * string's OWN query-string parameters are spread in LAST, after (and so silently overriding)
 * the explicit `connection: { search_path: schema }` this function sets below. **Found by a
 * fifth-round cross-vendor re-audit**: `createClient({ connectionString: uri +
 * "?search_path=public", schema: "tenant_a" })` would actually connect with `search_path=public`
 * while this module's own `umbradbSchema` property kept reporting `"tenant_a"` — a real,
 * silent schema-isolation violation that every other module in this codebase (migrate.ts's
 * lock keying, PgTemporalKV's default schema) trusts `umbradbSchema` to reflect accurately.
 * Reject a conflicting `search_path` query parameter up front, rather than let it silently win —
 * matching this file's existing "malformed config fails fast, here, with a clear message" style
 * (`assertValidSchemaName`), not a downstream symptom discovered later.
 */
function assertNoConflictingSearchPath(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return; // Not a URL-shaped string (e.g. a bare "postgresql://" with no host) -- postgres.js's
             // own parsing will reject it; nothing for this guard to check.
  }
  if (url.searchParams.has("search_path")) {
    throw new Error(
      "connectionString must not set a \"search_path\" query parameter -- it silently " +
      "overrides createClient's own \"schema\" option (postgres.js merges query-string " +
      "connection parameters after explicit ones). Pass the desired schema via the " +
      "\"schema\" option instead.",
    );
  }
}

export function createClient(opts: UmbraDBConnectionOptions = {}): UmbraDBSql {
  const schema = opts.schema ?? DEFAULT_SCHEMA;
  assertValidSchemaName(schema);
  if (opts.connectionString !== undefined) {
    assertNoConflictingSearchPath(opts.connectionString);
  }
  const options = {
    ...(opts.maxConnections !== undefined ? { max: opts.maxConnections } : {}),
    ...(opts.connectTimeout !== undefined ? { connect_timeout: opts.connectTimeout } : {}),
    connection: { search_path: schema },
    types: { bigint: postgres.BigInt },
  };
  // Two distinct postgres() overloads (url+options vs. options-only) — a `string | undefined`
  // connectionString doesn't cleanly match either, so branch explicitly rather than passing
  // `undefined` positionally (which is also the exact "explicit undefined" footgun this file's
  // own `max` fix exists to avoid elsewhere).
  const client = opts.connectionString !== undefined
    ? postgres(opts.connectionString, options)
    : postgres(options);
  Object.defineProperty(client, "umbradbSchema", { value: schema, enumerable: false, writable: false });
  return client as UmbraDBSql;
}
