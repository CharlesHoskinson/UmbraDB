import type { ISql } from "postgres";
import type { UmbraDBSql } from "./client.js";
import { translatePostgresError } from "./errors.js";

/** The common query surface `UmbraDBSql` (the general pool), a reserved connection
 *  (`ReservedSql`), and a transaction handle (`TransactionSql`) all share -- used to type the
 *  helpers below so they run identically regardless of which one calls them (Fix 6 runs them
 *  inside a transaction on a reserved connection; the pre-flight check still runs against the
 *  general pool). */
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
 */

export interface RolloverBucket {
  /** Inclusive lower bound (matches `CREATE TABLE ... FOR VALUES FROM (lo) TO (hi)`). */
  lo: number;
  /** Exclusive upper bound. */
  hi: number;
  /** Partition name suffix, e.g. `"p5"` for `blocks_p5`. Caller's responsibility to pick a name
   *  not already in use (this function does not compute it from `partition-config.ts`'s
   *  constants -- callers doing a REAL production rollover should derive it from those, tests
   *  are free to use whatever small bucket shape they're exercising). */
  suffix: string;
}

const ROLLOVER_TABLES = ["blocks", "transactions", "bridge_observations"] as const;
type RolloverTable = (typeof ROLLOVER_TABLES)[number];

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

/**
 * Runs the full v4 rollover runbook against `schema`'s `blocks`/`transactions`/
 * `bridge_observations` tables, creating one new bounded partition `bucket` on all three and
 * retiring their `DEFAULT` overflow into it. Idempotent in the sense that a `DEFAULT` partition
 * already correctly created (empty) is left as-is on completion; NOT safe to call concurrently
 * with itself or with live writers against the same schema (the design doc's own step 3 requires
 * pausing writers first -- this function does not manage that on the caller's behalf, matching
 * the doc's own "application-level, e.g. hold the same schema-scoped advisory lock migrate.ts's
 * runMigrations already uses" guidance, which a caller wraps this call with if needed).
 *
 * **Fix 6 (sprint-fix round, LOWER PRIORITY)**: steps (a)-(f) below now run inside ONE
 * `BEGIN...COMMIT` transaction on the reserved connection, not as individually-autocommitted
 * statements. Postgres DDL -- including `DETACH`/`ATTACH PARTITION`, `DROP CONSTRAINT`, `RENAME`,
 * and `CREATE TABLE ... PARTITION OF` -- is fully transactional, so this was feasible without any
 * change to the runbook's own step ordering. Previously, a connection drop or failure partway
 * through left the schema in a broken intermediate state (e.g. a table renamed to
 * `*_default_staging` but not yet re-attached) with no automated recovery -- wrapping the
 * sequence means a failure at any point rolls the schema back to its exact pre-rollover state
 * instead.
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
  try {
    // Pre-flight: refuse to proceed if any table's overflow doesn't fit the target bucket. Reads
    // only, against the general pool -- deliberately outside the transaction below (nothing to
    // roll back if this rejects, and it must observe already-committed state, not anything this
    // rollover itself is about to change).
    await assertDefaultSpanFitsOneBucket(sql, schema, "blocks", "height", bucket);
    await assertDefaultSpanFitsOneBucket(sql, schema, "transactions", "block_height", bucket);
    await assertDefaultSpanFitsOneBucket(sql, schema, "bridge_observations", "block_height", bucket);

    const reserved = await sql.reserve();
    try {
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
          await reserved.unsafe(`ALTER TABLE "${schema}".transactions_default DROP CONSTRAINT "${txFk}"`);
        }
        const bridgeFk = await getFkConstraintName(reserved, schema, "bridge_observations_default", "blocks");
        if (bridgeFk !== undefined) {
          await reserved.unsafe(`ALTER TABLE "${schema}".bridge_observations_default DROP CONSTRAINT "${bridgeFk}"`);
        }

        // (c) Now detach the parent -- succeeds since the FK that blocked it is gone.
        await reserved`ALTER TABLE ${reserved(schema)}.blocks DETACH PARTITION ${reserved(schema)}.blocks_default`;

        // (d) Rename every just-detached table out of the way (failure #2 -- duplicate_table).
        await reserved.unsafe(`ALTER TABLE "${schema}".blocks_default RENAME TO blocks_default_staging`);
        await reserved.unsafe(`ALTER TABLE "${schema}".transactions_default RENAME TO transactions_default_staging`);
        await reserved.unsafe(`ALTER TABLE "${schema}".bridge_observations_default RENAME TO bridge_observations_default_staging`);

        // (e) Reattach the staging data as correctly-bounded partitions BEFORE recreating DEFAULT
        // or resuming writers -- this ordering (not "recreate DEFAULT immediately") is what closes
        // the write-race window (failure #3). Parent before children, matching FK-validation order.
        const blocksP = `blocks_${bucket.suffix}`;
        const txP = `transactions_${bucket.suffix}`;
        const bridgeP = `bridge_observations_${bucket.suffix}`;
        await reserved.unsafe(`ALTER TABLE "${schema}".blocks_default_staging RENAME TO ${blocksP}`);
        await reserved.unsafe(
          `ALTER TABLE "${schema}".blocks ATTACH PARTITION "${schema}".${blocksP} FOR VALUES FROM (${bucket.lo}) TO (${bucket.hi})`,
        );
        await reserved.unsafe(`ALTER TABLE "${schema}".transactions_default_staging RENAME TO ${txP}`);
        await reserved.unsafe(
          `ALTER TABLE "${schema}".transactions ATTACH PARTITION "${schema}".${txP} FOR VALUES FROM (${bucket.lo}) TO (${bucket.hi})`,
        );
        await reserved.unsafe(`ALTER TABLE "${schema}".bridge_observations_default_staging RENAME TO ${bridgeP}`);
        await reserved.unsafe(
          `ALTER TABLE "${schema}".bridge_observations ATTACH PARTITION "${schema}".${bridgeP} FOR VALUES FROM (${bucket.lo}) TO (${bucket.hi})`,
        );

        // (f) Only now recreate empty DEFAULT partitions on all three tables.
        await reserved.unsafe(`CREATE TABLE "${schema}".blocks_default PARTITION OF "${schema}".blocks DEFAULT`);
        await reserved.unsafe(`CREATE TABLE "${schema}".transactions_default PARTITION OF "${schema}".transactions DEFAULT`);
        await reserved.unsafe(`CREATE TABLE "${schema}".bridge_observations_default PARTITION OF "${schema}".bridge_observations DEFAULT`);

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
