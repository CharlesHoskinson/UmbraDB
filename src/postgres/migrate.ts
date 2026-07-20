import type { ISql, Sql } from "postgres";
import { ValidationError } from "../interfaces/storage-errors.js";
import { assertValidSchemaName } from "./client.js";
import * as migration000 from "./migrations/000_schema.js";
import * as migration001 from "./migrations/001_temporal_kv.js";

interface Migration {
  name: string;
  up(sql: ISql, schema: string): Promise<void>;
}

/**
 * Runs `fn` against `reserved` wrapped in a manual `BEGIN`/`COMMIT`/`ROLLBACK` — NOT
 * `reserved.begin()`. Found at runtime (not by the type checker: `postgres.js`'s own `.d.ts`
 * claims `ReservedSql extends Sql`, which would imply `.begin()` exists): `sql.reserve()`'s
 * actual implementation builds its returned object via the bare `Sql(handler)` factory and
 * never applies the `Object.assign(sql, {..., begin, ...})` step that attaches `.begin` on the
 * top-level pooled client — a reserved connection has no `.begin` method at all, despite what
 * its type says. This is the one place in this file that must route around the type layer's
 * claim rather than trust it.
 */
async function withReservedTransaction<T>(reserved: ISql, fn: () => Promise<T>): Promise<T> {
  await reserved`BEGIN`;
  try {
    const result = await fn();
    await reserved`COMMIT`;
    return result;
  } catch (err) {
    await reserved`ROLLBACK`;
    throw err;
  }
}

const migrations: Migration[] = [migration000, migration001];

export interface RunMigrationsOptions {
  schema: string;
}

/**
 * Applies every not-yet-recorded migration in `migrations/` order, inside a schema-scoped
 * advisory lock so two concurrent callers (e.g. two application instances starting at once)
 * cannot both apply the same migration (`openspec/changes/sprint-1-setup-and-temporal-kv/design.md`
 * §2 — a real gap the original design left unspecified, found by audit). Idempotent: re-running
 * against an already-migrated schema applies zero migrations.
 *
 * Advisory lock uses the two-integer form with a fixed class constant `1` ("migrations") so it
 * can never collide with the writer-lease layer's own advisory locks, which use class `2`
 * (`design/design.md` §5).
 */
export async function runMigrations<TTypes extends Record<string, unknown> = {}>(
  sql: Sql<TTypes>, opts: RunMigrationsOptions,
): Promise<void> {
  try {
    assertValidSchemaName(opts.schema);
  } catch (err) {
    throw new ValidationError(
      `invalid schema name for runMigrations: ${opts.schema}`,
      [{ path: "schema", message: err instanceof Error ? err.message : String(err) }],
      err,
    );
  }

  const reserved = await sql.reserve();
  try {
    await reserved`select pg_advisory_lock(1, hashtext(${opts.schema}))`;
    // btree_gist opclass resolution fix (migrations/001_temporal_kv.ts's own comment) — widen
    // this connection's search_path so CREATE EXTENSION IF NOT EXISTS's operators are visible
    // even when previously installed into `public` by something else.
    await reserved`set search_path = ${reserved(opts.schema)}, public`;
    try {
      // to_regclass returns NULL (not an error) for a relation that doesn't exist yet, so this
      // is safe to call on a cold database even before migration 000 has ever run.
      const bootstrapped = await reserved<{ exists: boolean }[]>`
        select to_regclass(${opts.schema + "._migrations"}) is not null as exists
      `;
      // A FROM-less SELECT always returns exactly one row — not an assumption about this data,
      // a guarantee of the query shape itself.
      if (!bootstrapped[0]!.exists) {
        await withReservedTransaction(reserved, async () => {
          await migration000.up(reserved, opts.schema);
          await reserved`insert into ${reserved(opts.schema)}._migrations (name) values (${migration000.name})`;
        });
      }
      for (const m of migrations.slice(1)) {
        const applied = await reserved<{ one: number }[]>`
          select 1 as one from ${reserved(opts.schema)}._migrations where name = ${m.name}
        `;
        if (applied.length > 0) continue;
        await withReservedTransaction(reserved, async () => {
          await m.up(reserved, opts.schema);
          await reserved`insert into ${reserved(opts.schema)}._migrations (name) values (${m.name})`;
        });
      }
    } finally {
      await reserved`select pg_advisory_unlock(1, hashtext(${opts.schema}))`;
    }
  } finally {
    reserved.release();
  }
}
