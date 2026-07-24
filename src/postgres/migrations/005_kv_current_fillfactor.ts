import type { ISql } from "postgres";

/**
 * IS-1 (`openspec/changes/v1.0.0-perf-baseline/design.md` §3): tune `kv_current` for HOT (Heap-Only
 * Tuple) updates. `kv_current` is updated on every sync tick and its updates touch only non-indexed
 * columns (`value`/`version`/`updated_at`/`updated_xact`), so they are HOT-eligible by column but
 * miss HOT for lack of same-page slack under the default `fillfactor = 100`, spilling to new pages
 * and bloating the PK index under the soak workload. `fillfactor = 90` leaves per-page slack so an
 * updated row can stay on its page. Same value and rationale as `watermarks`
 * (`003_watermarks.ts`, this project's established template for a hot-update table).
 *
 * Forward-only `ALTER` (not an edit to `001_temporal_kv.ts`). `fillfactor` affects NEW pages only;
 * an existing packed table reclaims slack as rows turn over / on `VACUUM FULL`.
 *
 * Hard invariant (as for `watermarks`): never add an index on `kv_current`'s non-PK columns — it
 * would break HOT eligibility for every write and defeat this tuning.
 */
export const name = "005_kv_current_fillfactor";

export async function up(sql: ISql, schema: string): Promise<void> {
  await sql`ALTER TABLE ${sql(schema)}.kv_current SET (fillfactor = 90)`;
}
