import postgres, { type Sql } from "postgres";

/** The `Sql` type shape actually produced by `createClient` — includes the `bigint` type
 *  mapping (`postgres.BigInt`) configured below, so callers get real `bigint` in and out of
 *  tagged-template queries instead of the untyped `Sql<{}>` default (which rejects `bigint`
 *  query parameters at compile time and would otherwise force every consumer, including
 *  `PgTemporalKV`, to lose that type information at the createClient boundary). */
export type UmbraDBSql = Sql<{ bigint: bigint }>;

/** Default schema — see `openspec/changes/sprint-1-setup-and-temporal-kv/design.md` §0: a
 *  library default, not a name UmbraDB itself is embedded under. */
export const DEFAULT_SCHEMA = "umbradb";

/** Schema names must be safe to interpolate as SQL identifiers via `postgres.js`'s `sql(name)`
 *  helper. `sql(name)` already quotes/escapes correctly regardless of content, so this regex is
 *  defense-in-depth (a malformed config value fails fast with a clear message here, rather than
 *  producing confusing downstream DDL) — see design.md §2. */
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

export function assertValidSchemaName(schema: string): void {
  if (!SCHEMA_NAME_PATTERN.test(schema)) {
    throw new Error(`invalid schema name: ${JSON.stringify(schema)} (must match ${SCHEMA_NAME_PATTERN})`);
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
}

/**
 * Connection factory (design/design.md §3, corrected 2026-07-20 per that section's own
 * revision note for two real driver-config bugs): configures `search_path` to the target
 * schema and `types.bigint` so `version` columns round-trip as real JS `bigint`, matching
 * `src/interfaces/temporal-kv.ts`'s `StoredVersionSchema`.
 */
export function createClient(opts: UmbraDBConnectionOptions = {}): UmbraDBSql {
  const schema = opts.schema ?? DEFAULT_SCHEMA;
  assertValidSchemaName(schema);
  const options = {
    ...(opts.maxConnections !== undefined ? { max: opts.maxConnections } : {}),
    connection: { search_path: schema },
    types: { bigint: postgres.BigInt },
  };
  // Two distinct postgres() overloads (url+options vs. options-only) — a `string | undefined`
  // connectionString doesn't cleanly match either, so branch explicitly rather than passing
  // `undefined` positionally (which is also the exact "explicit undefined" footgun this file's
  // own `max` fix exists to avoid elsewhere).
  return opts.connectionString !== undefined
    ? postgres(opts.connectionString, options)
    : postgres(options);
}
