import type { ISql } from "postgres";
import { assertValidSchemaName, type UmbraDBSql } from "./client.js";
import { translatePostgresError } from "./errors.js";

/** The common query surface `UmbraDBSql` (the general pool), a reserved connection
 *  (`ReservedSql`), and a transaction handle (`TransactionSql`) all share -- used to type the
 *  helpers below so they run identically regardless of which one calls them. As of the
 *  Sol-audit fix round, EVERY query this module issues -- the idempotency check, the pre-flight
 *  span check, the FK lookups, and the DDL itself -- runs on the ONE reserved connection, never
 *  the general pool (see `rolloverDefaultPartition`'s doc for why that is load-bearing). */
type AnySql = ISql<{ bigint: bigint }>;

/**
 * Executable implementation of the chain-archive DEFAULT-partition rollover runbook
 * (`design/full-chain-storage-design.md` §4.6's v4 rewrite -- the procedure both round-3
 * design-council reviewers reproduced against a real Postgres 17 instance and rebuilt from four
 * concrete failure modes). This module turns that documented, hand-run procedure into a real,
 * callable, testable function -- AC-6 explicitly requires "a real rollover event," not reasoning
 * about the runbook prose.
 *
 * **Scope, matching the design doc's own "common case" fast path**: this implementation handles
 * the case where every row in each table's overflowed `DEFAULT` partition falls entirely inside
 * the ONE new bounded bucket `[lo, hi)` being created -- true whenever a rollover is triggered
 * before monitoring lags by more than one bucket width, which is the documented common case (the
 * design doc's own §4.6 step 2: "this should be the only path ever exercised on a healthy
 * deployment"). The doc's own fallback for a `DEFAULT` spanning MULTIPLE target buckets (split via
 * `CREATE ... (LIKE ... INCLUDING ALL)` + filtered `INSERT`/`DELETE` per bucket) is intentionally
 * NOT automated here -- out of scope for this pass, exactly as the design doc itself states
 * ("pg_partman or an equivalent scheduled job runner remains the recommended way to automate step
 * 2 on a timer... this pass still does not build that automation"). If any row in a table's
 * `DEFAULT` partition falls outside `[lo, hi)`, this function refuses to proceed (see
 * `assertDefaultSpanFitsOneBucket`) rather than silently mis-route data -- a deliberate
 * fail-loud choice over a partial/incorrect rollover.
 *
 * FK constraint names are looked up dynamically via `pg_constraint`/`pg_class` rather than
 * hardcoded string-matched against the design doc's own transcript (which was captured against a
 * differently-shaped test schema at smaller scale) -- this is what makes the function correct
 * against the REAL migration's actual generated constraint names, not just the doc's example.
 *
 * **Identifier-injection hardening (Sol-audit fix round, Finding 2)**: this module necessarily
 * interpolates identifiers into raw `.unsafe()` DDL strings (postgres.js cannot parameterize
 * DDL identifiers). Every interpolated identifier is now gated: `schema` through the same
 * `assertValidSchemaName` the migration itself uses, `bucket.suffix` through
 * `assertValidPartitionSuffix` below (strict `^[a-z][a-z0-9_]*$` plus the 63-byte identifier
 * bound on the LONGEST derived table name), `bucket.lo`/`bucket.hi` through
 * `assertValidBucketBounds` (real, safe, non-negative integers with `lo < hi` -- never
 * interpolated as arbitrary strings), and catalog-returned constraint names through
 * `quoteIdent`'s standard double-quote escaping (defense-in-depth: `pg_constraint.conname`
 * values are server-controlled, but an adversarially-named constraint must still not break out
 * of its quoted position).
 */

export interface RolloverBucket {
  /** Inclusive lower bound (matches `CREATE TABLE ... FOR VALUES FROM (lo) TO (hi)`). */
  lo: number;
  /** Exclusive upper bound. */
  hi: number;
  /** Partition name suffix, e.g. `"p5"` for `blocks_p5`. Caller's responsibility to pick a name
   *  not already in use (this function does not compute it from `partition-config.ts`'s
   *  constants -- callers doing a REAL production rollover should derive it from those, tests
   *  are free to use whatever small bucket shape they're exercising). Must match
   *  `^[a-z][a-z0-9_]*$` -- rejected before any SQL is issued otherwise. */
  suffix: string;
}

const ROLLOVER_TABLES = ["blocks", "transactions", "bridge_observations"] as const;
type RolloverTable = (typeof ROLLOVER_TABLES)[number];

const PARTITION_SUFFIX_PATTERN = /^[a-z][a-z0-9_]*$/;
const POSTGRES_MAX_IDENTIFIER_BYTES = 63;
/** Longest derived identifier is `bridge_observations_default_staging`-style; the bound below is
 *  computed against the longest actual prefix so a valid suffix can never yield a table name
 *  Postgres would silently truncate (the same silent-truncation aliasing hazard
 *  `assertValidSchemaName` documents). */
const LONGEST_TABLE_PREFIX = "bridge_observations_".length;

/** Strict allowlist gate for the caller-controlled partition suffix -- interpolated into raw DDL
 *  below, so anything not matching a bare lowercase identifier is rejected up front, before ANY
 *  SQL (including the read-only pre-flight) is issued. */
export function assertValidPartitionSuffix(suffix: string): void {
  if (!PARTITION_SUFFIX_PATTERN.test(suffix)) {
    throw new Error(
      `invalid rollover partition suffix: ${JSON.stringify(suffix)} (must match ${PARTITION_SUFFIX_PATTERN})`,
    );
  }
  if (LONGEST_TABLE_PREFIX + suffix.length > POSTGRES_MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `invalid rollover partition suffix: ${JSON.stringify(suffix)} would exceed PostgreSQL's ` +
      `${POSTGRES_MAX_IDENTIFIER_BYTES}-byte identifier limit on "bridge_observations_${suffix}"`,
    );
  }
}

/** `lo`/`hi` are interpolated into `FOR VALUES FROM (lo) TO (hi)` -- they must be real, safe,
 *  non-negative integers (never arbitrary strings), and a well-formed range. */
function assertValidBucketBounds(bucket: RolloverBucket): void {
  for (const [name, value] of [["lo", bucket.lo], ["hi", bucket.hi]] as const) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `invalid rollover bucket bound ${name}: ${JSON.stringify(value)} (must be a non-negative safe integer)`,
      );
    }
  }
  if (bucket.lo >= bucket.hi) {
    throw new Error(`invalid rollover bucket: lo (${bucket.lo}) must be < hi (${bucket.hi})`);
  }
}

/** Standard SQL identifier quoting (double any embedded `"`), for values that go into raw DDL
 *  strings. Validated inputs (schema/suffix-derived names) can't contain `"` at all; catalog-
 *  returned constraint names get this as defense-in-depth. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function getFkConstraintName(
  sql: AnySql, schema: string, childTable: string, parentTable: string,
): Promise<string | undefined> {
  const rows = await sql<{ conname: string }[]>`
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class child ON child.oid = c.conrelid
    JOIN pg_class parent ON parent.oid = c.confrelid
    JOIN pg_namespace ns ON ns.oid = child.relnamespace
    WHERE c.contype = 'f' AND ns.nspname = ${schema}
      AND child.relname = ${childTable} AND parent.relname = ${parentTable}
  `;
  return rows[0]?.conname;
}

async function assertDefaultSpanFitsOneBucket(
  sql: AnySql, schema: string, table: RolloverTable, heightColumn: string, bucket: RolloverBucket,
): Promise<void> {
  const rows = await sql<{ min_h: string | null; max_h: string | null }[]>`
    SELECT min(${sql(heightColumn)})::text AS min_h, max(${sql(heightColumn)})::text AS max_h
    FROM ${sql(schema)}.${sql(table + "_default")}
  `;
  const minH = rows[0]?.min_h;
  const maxH = rows[0]?.max_h;
  if (minH === null || minH === undefined) return; // empty DEFAULT -- nothing to check
  if (Number(minH) < bucket.lo || Number(maxH) >= bucket.hi) {
    throw new Error(
      `${table}_default holds rows outside the target bucket [${bucket.lo}, ${bucket.hi}) ` +
      `(observed range [${minH}, ${maxH}]) -- this rollover helper only automates the single-` +
      "bucket common case (design doc §4.6 step 2); a DEFAULT spanning multiple buckets needs " +
      "the doc's documented multi-bucket split fallback, not automated here.",
    );
  }
}

/** The `FOR VALUES FROM ('lo') TO ('hi')` bound expression Postgres reports for an attached
 *  partition, or `undefined` if `schema.tableName` is not currently an attached partition of
 *  `schema.parentTable`. */
async function attachedPartitionBound(
  sql: AnySql, schema: string, parentTable: string, tableName: string,
): Promise<string | undefined> {
  const rows = await sql<{ bound: string }[]>`
    SELECT pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_namespace pns ON pns.oid = parent.relnamespace
    WHERE ns.nspname = ${schema} AND c.relname = ${tableName}
      AND pns.nspname = ${schema} AND parent.relname = ${parentTable}
  `;
  return rows[0]?.bound;
}

/**
 * Sol-audit fix round, Finding 3(b): detects whether THIS bucket's rollover has already fully
 * happened, so a repeated invocation short-circuits to a safe no-op instead of re-attempting
 * destructive steps (previously: a second call detached/renamed the fresh DEFAULT partitions and
 * then failed on the already-existing `<table>_<suffix>` name -- and before the transaction wrap
 * was added, that failure abandoned the partition hierarchy dismantled mid-way, directly
 * contradicting the function's idempotency claim).
 *
 * Returns `true` only when ALL THREE target partitions (`blocks_<suffix>`,
 * `transactions_<suffix>`, `bridge_observations_<suffix>`) exist attached to their parents with
 * exactly the requested `[lo, hi)` bounds. Throws if the suffix is partially applied, or applied
 * with DIFFERENT bounds (a suffix reuse mistake), rather than guessing.
 */
async function rolloverAlreadyApplied(
  sql: AnySql, schema: string, bucket: RolloverBucket,
): Promise<boolean> {
  const expectedBound = `FOR VALUES FROM ('${bucket.lo}') TO ('${bucket.hi}')`;
  const states = await Promise.all(
    ROLLOVER_TABLES.map(async (table) => ({
      table,
      bound: await attachedPartitionBound(sql, schema, table, `${table}_${bucket.suffix}`),
    })),
  );
  const attached = states.filter((s) => s.bound !== undefined);
  if (attached.length === 0) return false;
  if (attached.length < ROLLOVER_TABLES.length) {
    throw new Error(
      `rollover suffix "${bucket.suffix}" is PARTIALLY applied in schema "${schema}" ` +
      `(attached: ${attached.map((s) => s.table).join(", ") || "none"}; ` +
      `missing: ${states.filter((s) => s.bound === undefined).map((s) => s.table).join(", ")}) -- ` +
      "refusing to guess; repair the partition hierarchy manually before re-running",
    );
  }
  const wrongBound = attached.find((s) => s.bound !== expectedBound);
  if (wrongBound !== undefined) {
    throw new Error(
      `rollover suffix "${bucket.suffix}" already exists in schema "${schema}" with DIFFERENT ` +
      `bounds (${wrongBound.table}_${bucket.suffix}: ${wrongBound.bound}, requested: ` +
      `${expectedBound}) -- pick an unused suffix instead of reusing this one`,
    );
  }
  return true;
}

/**
 * Runs the full v4 rollover runbook against `schema`'s `blocks`/`transactions`/
 * `bridge_observations` tables, creating one new bounded partition `bucket` on all three and
 * retiring their `DEFAULT` overflow into it. Idempotent for real (Sol-audit fix round, Finding
 * 3(b)): a repeat invocation with the same `(suffix, lo, hi)` after a fully-successful run is a
 * safe no-op (detected up front via the catalog, see `rolloverAlreadyApplied`), and a failed run
 * rolls back to the exact pre-rollover state (single transaction, below). NOT safe to call
 * concurrently with itself or with live writers against the same schema (the design doc's own
 * step 3 requires pausing writers first -- this function does not manage that on the caller's
 * behalf, matching the doc's own "application-level, e.g. hold the same schema-scoped advisory
 * lock migrate.ts's runMigrations already uses" guidance, which a caller wraps this call with if
 * needed).
 *
 * **Single-connection discipline (Sol-audit fix round, Finding 3(a))**: every query this
 * function issues -- the idempotency catalog check, the pre-flight span checks, the FK-name
 * lookups, and the DDL -- runs on the ONE connection reserved at the top. Nothing here ever
 * touches the general pool after the reservation, so the function cannot self-deadlock waiting
 * for a pool connection it is itself holding -- which is exactly what a mid-operation general-
 * pool query does under this repo's supported `maxConnections: 1` configuration (verified by a
 * real `maxConnections: 1` rollover test, `test/postgres/chain-archive-rollover.test.ts`).
 * The FK lookups additionally MUST run on the reserved connection for correctness: they must see
 * this same transaction's own uncommitted DETACH, not just already-committed state.
 *
 * **Fix 6 (prior sprint-fix round, retained)**: steps (a)-(f) below run inside ONE
 * `BEGIN...COMMIT` transaction on the reserved connection, not as individually-autocommitted
 * statements. Postgres DDL -- including `DETACH`/`ATTACH PARTITION`, `DROP CONSTRAINT`,
 * `RENAME`, and `CREATE TABLE ... PARTITION OF` -- is fully transactional, so a failure at any
 * point rolls the schema back to its exact pre-rollover state instead of leaving a broken
 * intermediate (e.g. a table renamed to `*_default_staging` but not yet re-attached).
 *
 * The transaction is driven by explicit `BEGIN`/`COMMIT`/`ROLLBACK` statements on the reserved
 * connection itself, NOT `sql.begin(...)` / a hypothetical `reserved.begin(...)` --
 * **empirically confirmed against this project's actual installed postgres.js (v3.4.9)** while
 * implementing this fix: `reserve()`'s returned connection is a raw `Sql` instance built via the
 * library's internal `Sql(handler)` factory, and `begin`/`reserve`/`listen`/`close`/`end` are
 * ONLY ever attached to the one top-level pool object `postgres()` returns (`Object.assign(sql,
 * { ..., reserve, begin, ... })` in `postgres.js`'s own `index.js`) -- `reserved.begin` does not
 * exist at runtime despite the package's own `.d.ts` typings claiming `ReservedSql extends Sql`
 * (which includes `begin`); calling it throws `TypeError: reserved.begin is not a function`,
 * caught by this project's own real-Postgres rollover test while implementing this fix, not
 * assumed from reading the types alone. Manual `BEGIN`/`COMMIT`/`ROLLBACK` tagged-template calls
 * on the reserved connection is the same pattern this repo's own
 * `test/postgres/chain-archive-migrate.test.ts` already uses successfully for exercising real
 * multi-statement transactions on a reserved connection, and works precisely because a reserved
 * connection already guarantees every statement issued through it runs on the SAME physical
 * connection, in order.
 */
export async function rolloverDefaultPartition(
  sql: UmbraDBSql, schema: string, bucket: RolloverBucket,
): Promise<void> {
  // Finding 2: validate EVERY caller-controlled value interpolated into DDL below, before any
  // SQL (even read-only) is issued.
  assertValidSchemaName(schema);
  assertValidPartitionSuffix(bucket.suffix);
  assertValidBucketBounds(bucket);
  const schemaIdent = quoteIdent(schema);

  try {
    const reserved = await sql.reserve();
    try {
      // Finding 3(b): if this exact rollover already fully happened, this is a retry -- no-op.
      if (await rolloverAlreadyApplied(reserved, schema, bucket)) return;

      // Pre-flight: refuse to proceed if any table's overflow doesn't fit the target bucket.
      // Read-only, on the reserved connection (Finding 3(a)), deliberately outside the
      // transaction below (nothing to roll back if this rejects, and it must observe already-
      // committed state, not anything this rollover itself is about to change).
      await assertDefaultSpanFitsOneBucket(reserved, schema, "blocks", "height", bucket);
      await assertDefaultSpanFitsOneBucket(reserved, schema, "transactions", "block_height", bucket);
      await assertDefaultSpanFitsOneBucket(reserved, schema, "bridge_observations", "block_height", bucket);

      await reserved`BEGIN`;
      try {
        // (a) Detach children before the parent -- load-bearing ordering (§4.6 finding #1).
        await reserved`ALTER TABLE ${reserved(schema)}.transactions DETACH PARTITION ${reserved(schema)}.transactions_default`;
        await reserved`ALTER TABLE ${reserved(schema)}.bridge_observations DETACH PARTITION ${reserved(schema)}.bridge_observations_default`;

        // (b) Drop the retained FK constraint on each detached child (cascades to internal
        // per-partition clones automatically -- confirmed in the design doc's own transcript).
        // Looked up via `reserved` (not the general pool) so this sees this same transaction's
        // own uncommitted DETACH above, not just already-committed state.
        const txFk = await getFkConstraintName(reserved, schema, "transactions_default", "blocks");
        if (txFk !== undefined) {
          await reserved.unsafe(`ALTER TABLE ${schemaIdent}.transactions_default DROP CONSTRAINT ${quoteIdent(txFk)}`);
        }
        const bridgeFk = await getFkConstraintName(reserved, schema, "bridge_observations_default", "blocks");
        if (bridgeFk !== undefined) {
          await reserved.unsafe(`ALTER TABLE ${schemaIdent}.bridge_observations_default DROP CONSTRAINT ${quoteIdent(bridgeFk)}`);
        }

        // (c) Now detach the parent -- succeeds since the FK that blocked it is gone.
        await reserved`ALTER TABLE ${reserved(schema)}.blocks DETACH PARTITION ${reserved(schema)}.blocks_default`;

        // (d) Rename every just-detached table out of the way (failure #2 -- duplicate_table).
        await reserved.unsafe(`ALTER TABLE ${schemaIdent}.blocks_default RENAME TO blocks_default_staging`);
        await reserved.unsafe(`ALTER TABLE ${schemaIdent}.transactions_default RENAME TO transactions_default_staging`);
        await reserved.unsafe(`ALTER TABLE ${schemaIdent}.bridge_observations_default RENAME TO bridge_observations_default_staging`);

        // (e) Reattach the staging data as correctly-bounded partitions BEFORE recreating DEFAULT
        // or resuming writers -- this ordering (not "recreate DEFAULT immediately") is what closes
        // the write-race window (failure #3). Parent before children, matching FK-validation order.
        const blocksP = quoteIdent(`blocks_${bucket.suffix}`);
        const txP = quoteIdent(`transactions_${bucket.suffix}`);
        const bridgeP = quoteIdent(`bridge_observations_${bucket.suffix}`);
        await reserved.unsafe(`ALTER TABLE ${schemaIdent}.blocks_default_staging RENAME TO ${blocksP}`);
        await reserved.unsafe(
          `ALTER TABLE ${schemaIdent}.blocks ATTACH PARTITION ${schemaIdent}.${blocksP} FOR VALUES FROM (${bucket.lo}) TO (${bucket.hi})`,
        );
        await reserved.unsafe(`ALTER TABLE ${schemaIdent}.transactions_default_staging RENAME TO ${txP}`);
        await reserved.unsafe(
          `ALTER TABLE ${schemaIdent}.transactions ATTACH PARTITION ${schemaIdent}.${txP} FOR VALUES FROM (${bucket.lo}) TO (${bucket.hi})`,
        );
        await reserved.unsafe(`ALTER TABLE ${schemaIdent}.bridge_observations_default_staging RENAME TO ${bridgeP}`);
        await reserved.unsafe(
          `ALTER TABLE ${schemaIdent}.bridge_observations ATTACH PARTITION ${schemaIdent}.${bridgeP} FOR VALUES FROM (${bucket.lo}) TO (${bucket.hi})`,
        );

        // (f) Only now recreate empty DEFAULT partitions on all three tables.
        await reserved.unsafe(`CREATE TABLE ${schemaIdent}.blocks_default PARTITION OF ${schemaIdent}.blocks DEFAULT`);
        await reserved.unsafe(`CREATE TABLE ${schemaIdent}.transactions_default PARTITION OF ${schemaIdent}.transactions DEFAULT`);
        await reserved.unsafe(`CREATE TABLE ${schemaIdent}.bridge_observations_default PARTITION OF ${schemaIdent}.bridge_observations DEFAULT`);

        await reserved`COMMIT`;
        // (g) Resume writers -- caller's responsibility (see this function's own doc above).
      } catch (err) {
        // Best-effort rollback -- if the connection itself died, there is nothing left to roll
        // back on, and the original `err` (not a secondary rollback failure) is what the caller
        // needs to see.
        await reserved`ROLLBACK`.catch(() => {});
        throw err;
      }
    } finally {
      reserved.release();
    }
  } catch (err) {
    throw translatePostgresError(err);
  }
}

export { ROLLOVER_TABLES };
