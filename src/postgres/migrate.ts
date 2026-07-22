import type { ISql, Sql } from "postgres";
import { ValidationError } from "../interfaces/storage-errors.js";
import { assertValidSchemaName } from "./client.js";
import { translatePostgresError } from "./errors.js";
import * as migration000 from "./migrations/000_schema.js";
import * as migration001 from "./migrations/001_temporal_kv.js";
import * as migration002 from "./migrations/002_checkpoint_store.js";
import * as migration003 from "./migrations/003_watermarks.js";
import * as migration004 from "./migrations/004_transaction_history.js";

/** Exported so a second migration lineage (e.g. `./migrations/chain_archive/index.ts`'s
 *  `chainArchiveMigrations`) can be typed against the same shape without duplicating it. */
export interface Migration {
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

/** UmbraDB's own Tier-1 (`design/design.md` §0) wallet/checkpoint migration lineage. Renamed
 *  from the previous unexported `migrations` to make room for `RunMigrationsOptions.migrations`
 *  selecting a different lineage (e.g. the Tier-1.5 chain-archive one) — this is still the
 *  default every existing caller gets when it omits that option, so this rename changes no
 *  runtime behavior for any current call site. */
const tier1WalletMigrations: Migration[] = [migration000, migration001, migration002, migration003, migration004];

export interface RunMigrationsOptions {
  schema: string;
  /**
   * Which migration lineage to apply. Defaults to `tier1WalletMigrations` — every existing
   * caller that doesn't pass this continues to get exactly the migrations it always did.
   *
   * This option is the "small addition" `design/full-chain-storage-design.md` §5 (Tier-1.5)
   * needed to support a second, independent migration lineage living in its own schema: no
   * change to `000_schema.ts` itself was required (its `up()` was already fully
   * schema-parameterized), and no generic multi-lineage registry/framework was built beyond
   * this one option — a caller that wants the chain-archive lineage passes
   * `chainArchiveMigrations` (`./migrations/chain_archive/index.ts`) here explicitly, alongside
   * a `schema` naming the schema it should live in (conventionally `chain_archive`).
   *
   * **Nothing in this repo's application code passes this today** — the chain-archive lineage
   * remains an unregistered, inert, design-stage artifact exactly as it was before this option
   * existed; this only makes it possible to run it, not wired to actually run it anywhere.
   */
  migrations?: Migration[];
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

  // Found by a fourth-round cross-vendor re-audit: this function never routed any of its own
  // failures through translatePostgresError, so a reserve failure, a migration-query failure, or
  // a cleanup-statement failure would all escape as raw postgres.js/Node errors — contradicting
  // this project's shared no-raw-driver-errors convention (design/design.md §4a). The wrapping
  // below covers the whole function; translatePostgresError itself already passes any error that
  // is ALREADY one of this project's own StorageError subclasses through unchanged (the
  // ValidationError thrown just above this point never reaches this wrapper, since it's outside
  // the try below — but if it ever did, it would still come back unchanged, not re-wrapped).
  try {
    return await runMigrationsImpl(sql, opts);
  } catch (err) {
    throw translatePostgresError(err);
  }
}

async function runMigrationsImpl<TTypes extends Record<string, unknown> = {}>(
  sql: Sql<TTypes>, opts: RunMigrationsOptions,
): Promise<void> {
  const lineage = opts.migrations ?? tier1WalletMigrations;
  const reserved = await sql.reserve();
  // Revised after a cross-vendor audit found two related bugs in this function's cleanup:
  // (1) `search_path` was widened on this connection but never restored before `release()`,
  // and `release()` just returns the same physical connection to the shared pool — so every
  // later, unrelated query that happens to land on this backend would silently run under the
  // wrong `search_path`. (2) the advisory-lock `finally` only wrapped the code AFTER `SET
  // search_path` ran; if that specific statement were cancelled (already having acquired the
  // lock a moment earlier), the lock would never be released and the connection would still go
  // back to the pool holding it. `lockHeld` tracks the lock across both fixes: it flips to
  // `true` immediately once the acquire statement itself resolves — before anything else runs
  // — so the unlock in the outer `finally` covers every failure after that point, including a
  // cancelled `SET search_path`.
  let lockHeld = false;
  try {
    await reserved`select pg_advisory_lock(1, hashtext(${opts.schema}))`;
    lockHeld = true;
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
        // `lineage[0]` rather than the hardcoded `migration000` import: every lineage this
        // repo defines (`tier1WalletMigrations`, `chainArchiveMigrations`) starts with the same
        // schema-bootstrap migration, but this reads that fact off `opts.migrations` itself
        // instead of silently assuming it — a future third lineage that didn't start with a
        // schema-bootstrap migration would surface as a real bug here (a missing `_migrations`
        // table) rather than a mismatched hardcoded reference silently running the wrong thing.
        const bootstrap = lineage[0]!;
        await withReservedTransaction(reserved, async () => {
          await bootstrap.up(reserved, opts.schema);
          await reserved`insert into ${reserved(opts.schema)}._migrations (name) values (${bootstrap.name})`;
        });
      }
      for (const m of lineage.slice(1)) {
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
      // Reset search_path before this connection can possibly go back to the pool, regardless
      // of what happens below (the lock unlock, or release()) — a connection carrying a
      // schema-scoped search_path back into the shared pool would silently mis-scope every
      // later unrelated query that happens to land on this same physical backend.
      await reserved`reset search_path`;
    }
  } finally {
    try {
      if (lockHeld) {
        await reserved`select pg_advisory_unlock(1, hashtext(${opts.schema}))`;
      }
    } finally {
      reserved.release();
    }
  }
}
