import type { UmbraDBSql } from "./client.js";
import { translatePostgresError } from "./errors.js";

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
  sql: UmbraDBSql, schema: string, childTable: string, parentTable: string,
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
  sql: UmbraDBSql, schema: string, table: RolloverTable, heightColumn: string, bucket: RolloverBucket,
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
 */
export async function rolloverDefaultPartition(
  sql: UmbraDBSql, schema: string, bucket: RolloverBucket,
): Promise<void> {
  try {
    // Pre-flight: refuse to proceed if any table's overflow doesn't fit the target bucket.
    await assertDefaultSpanFitsOneBucket(sql, schema, "blocks", "height", bucket);
    await assertDefaultSpanFitsOneBucket(sql, schema, "transactions", "block_height", bucket);
    await assertDefaultSpanFitsOneBucket(sql, schema, "bridge_observations", "block_height", bucket);

    const reserved = await sql.reserve();
    try {
      // (a) Detach children before the parent -- load-bearing ordering (§4.6 finding #1).
      await reserved`ALTER TABLE ${reserved(schema)}.transactions DETACH PARTITION ${reserved(schema)}.transactions_default`;
      await reserved`ALTER TABLE ${reserved(schema)}.bridge_observations DETACH PARTITION ${reserved(schema)}.bridge_observations_default`;

      // (b) Drop the retained FK constraint on each detached child (cascades to internal
      // per-partition clones automatically -- confirmed in the design doc's own transcript).
      const txFk = await getFkConstraintName(sql, schema, "transactions_default", "blocks");
      if (txFk !== undefined) {
        await reserved.unsafe(`ALTER TABLE "${schema}".transactions_default DROP CONSTRAINT "${txFk}"`);
      }
      const bridgeFk = await getFkConstraintName(sql, schema, "bridge_observations_default", "blocks");
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
      // (g) Resume writers -- caller's responsibility (see this function's own doc above).
    } finally {
      reserved.release();
    }
  } catch (err) {
    throw translatePostgresError(err);
  }
}

export { ROLLOVER_TABLES };
