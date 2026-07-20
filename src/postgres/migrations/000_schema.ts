import type { ISql } from "postgres";

/**
 * Schema + `_migrations` bookkeeping table bootstrap
 * (`openspec/changes/sprint-1-setup-and-temporal-kv/design.md` §2). `migrate.ts`'s
 * `runMigrations` only calls this when `to_regclass('<schema>._migrations')` is NULL, so this
 * does not need `IF NOT EXISTS` on the table itself — that check is the actual guard; adding a
 * redundant one here would mask a bug in the check rather than defend against anything real.
 */
export const name = "000_schema";

export async function up(sql: ISql, schema: string): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
  await sql`
    CREATE TABLE ${sql(schema)}._migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}
