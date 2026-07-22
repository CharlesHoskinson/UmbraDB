import { runMigrations } from "../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../src/postgres/migrations/chain_archive/index.js";
import type { UmbraDBSql } from "../src/postgres/client.js";

/**
 * The real invocation path `chainArchiveMigrations` was missing (`src/postgres/migrate.ts`'s own
 * doc: "nothing in this repo's application code passes this today"). Mirrors how the Tier-1
 * lineage is actually invoked in this codebase: there is no dedicated CLI entry point or npm
 * script for `tier1WalletMigrations` either (checked -- `package.json` has no `migrate` script,
 * and the only real callers of `runMigrations` anywhere in this repo are test setup helpers,
 * `test/postgres/setup.ts:26` and `test/postgres/chain-archive-migrate.test.ts`'s own direct
 * calls) -- this codebase's established pattern is "the consuming module bootstraps its own
 * schema on startup," not a separate migration-runner binary. `bootstrapChainArchiveSchema` is
 * that pattern's Tier-1.5 equivalent: the one real, non-test call site a production caller (or
 * this directory's own sync service / integration tests) uses before ingesting anything, and it
 * IS exercised for real against a live Postgres instance by
 * `test/integration/chain-archive-sync.integration.test.ts` (not just the already-existing
 * `test/postgres/chain-archive-migrate.test.ts` unit-level migration test).
 */
export async function bootstrapChainArchiveSchema(sql: UmbraDBSql, schema = "chain_archive"): Promise<void> {
  await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
}
