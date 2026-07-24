import type { ISql } from "postgres";

/**
 * IS-2 (`openspec/changes/v1.0.0-perf-baseline/design.md` §2): add a stored `size_bytes` generated
 * column to `ckpt_chunks` so `history()`'s aggregate can `sum(size_bytes)` WITHOUT detoasting the
 * `data` bytea (HP-2). `GENERATED ALWAYS AS (octet_length(data)) STORED` backfills every existing
 * row at migration time and is computed for all future inserts, so it never drifts from `data`. The
 * pattern is already proven in-repo at `migrations/chain_archive/001_chain_archive_core.ts`
 * (`size_bytes integer GENERATED ALWAYS AS (octet_length(data)) STORED`).
 *
 * Forward-only `ADD COLUMN` (not an edit to `002_checkpoint_store.ts`).
 */
export const name = "006_ckpt_chunks_size_bytes";

export async function up(sql: ISql, schema: string): Promise<void> {
  await sql`
    ALTER TABLE ${sql(schema)}.ckpt_chunks
    ADD COLUMN size_bytes integer GENERATED ALWAYS AS (octet_length(data)) STORED
  `;
}
