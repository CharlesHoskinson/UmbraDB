import type { ISql } from "postgres";

/**
 * `watermarks` DDL (`openspec/changes/sprint-4-watermarks/design.md` §1/§9, `design/design.md`
 * §4). Schema-qualified via `sql(schema)`, matching `001_temporal_kv.ts`/`002_checkpoint_store.ts`'s
 * established pattern. `fillfactor = 90` is the one physical-parameter correction this sprint
 * makes to `design/design.md` §4's original sketch: this table is updated on every sync tick
 * (few rows, extremely high per-row UPDATE frequency), exactly the workload HOT (Heap-Only Tuple)
 * updates exist for, and the default fillfactor of 100 leaves no per-page slack for an updated
 * row to land on the same page. Hard invariant, binding on any future change to this table: never
 * add an index on `value` or `updated_at` -- either would break HOT eligibility for every write.
 */
export const name = "003_watermarks";

export async function up(sql: ISql, schema: string): Promise<void> {
  await sql`
    CREATE TABLE ${sql(schema)}.watermarks (
      kind       text NOT NULL,
      key        text NOT NULL,
      value      jsonb NOT NULL,
      -- now() (transaction-start time), not clock_timestamp(): two writes to the same key in one
      -- transaction share this value, but nothing in this module's contract depends on
      -- updated_at for ordering (contrast TemporalKV's Law T4, which genuinely needed
      -- clock_timestamp() -- Watermarks has no such invariant; this field is diagnostic only).
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (kind, key)
    ) WITH (fillfactor = 90)
  `;
}
