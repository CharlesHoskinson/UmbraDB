import type { ISql } from "postgres";

/**
 * `kv_current`/`kv_history` DDL (`openspec/changes/sprint-1-setup-and-temporal-kv/design.md`
 * §2, `design/design.md` §2). Every identifier is schema-qualified via `sql(schema)` — the
 * safe-identifier-interpolation fix for the schema-configurability contradiction a 2026-07-20
 * audit found in the original static-`.sql`-file design (see design.md §2's revision note).
 */
export const name = "001_temporal_kv";

export async function up(sql: ISql, schema: string): Promise<void> {
  // btree_gist's operator classes are resolved via search_path at CREATE TABLE time, same as
  // any catalog object. `CREATE EXTENSION IF NOT EXISTS` is a global, database-scoped no-op if
  // btree_gist already exists ANYWHERE in this database (extension names are unique per
  // database, not per schema) — common on managed Postgres where it's pre-installed in
  // `public`. `migrate.ts`'s `runMigrations` widens THIS connection's search_path to
  // `<schema>, public` before calling any migration, specifically to fix this — every object
  // this migration creates is schema-qualified via `sql(schema)` so widening the path cannot
  // collide with anything.
  //
  // Revised after a cross-vendor audit found a real race here: `runMigrations`'s advisory lock
  // is keyed per-schema (`hashtext(schema)`), so two DIFFERENT schemas' migrations run under
  // DIFFERENT lock keys and can execute concurrently — but `CREATE EXTENSION IF NOT EXISTS`
  // touches one shared, database-global `pg_extension` catalog row regardless of schema.
  // PostgreSQL's own extension-creation code has a documented existence-check-then-insert race
  // for exactly this case: two concurrent `CREATE EXTENSION IF NOT EXISTS` calls can both pass
  // the precheck and race inserting the catalog row, and one fails outright instead of
  // no-op'ing. Fix: a second, schema-INDEPENDENT advisory lock (class `3`, fixed key `0` — a
  // constant, not derived from `schema`) that every schema's migration acquires before this
  // statement.
  //
  // **Revised AGAIN after a follow-up cross-vendor re-audit found the first fix (a session-level
  // `pg_advisory_lock`/`pg_advisory_unlock` pair around just this one statement) still didn't
  // work**: this `up()` function always runs inside `migrate.ts`'s `withReservedTransaction`
  // (a real `BEGIN`/`COMMIT`), and `CREATE EXTENSION`'s effect on `pg_extension` — like any DML
  // — is only visible to OTHER sessions once that transaction actually COMMITS, not the instant
  // the statement itself finishes executing. Releasing the lock right after the statement (but
  // before the enclosing COMMIT) let a second migration acquire the now-free lock, find the
  // extension not yet visible in its own snapshot, and race the same catalog insert anyway —
  // the exact original defect, just delayed by one lock-acquisition. It also meant a genuine
  // `CREATE EXTENSION` failure (not the benign "already exists" case) would abort this
  // transaction and make the `finally`'s `pg_advisory_unlock` itself fail (SQLSTATE `25P02`,
  // "current transaction is aborted") — and a session-level lock is NOT released by ROLLBACK,
  // so it would leak on the pooled connection, potentially wedging every future migration's
  // extension step.
  //
  // Fix: `pg_advisory_xact_lock`, not `pg_advisory_lock` — transaction-scoped, released
  // automatically at this transaction's COMMIT *or* ROLLBACK, no manual unlock and therefore no
  // unlock-inside-an-aborted-transaction failure mode. Because release now happens at COMMIT
  // (not at statement completion), a second migration blocked on this lock only proceeds once
  // the first's entire transaction — including its CREATE EXTENSION — has actually committed,
  // so its own subsequent statement genuinely sees the extension as installed. The lock is held
  // for the rest of this transaction rather than just this one statement, which is an
  // acceptable, negligible cost for a one-time migration step.
  await sql`select pg_advisory_xact_lock(3, 0)`;
  await sql`
    CREATE EXTENSION IF NOT EXISTS btree_gist
  `;

  // updated_at truncates clock_timestamp() to millisecond precision. Found by actually running
  // the test suite, not by any prior audit: Postgres timestamptz carries microsecond precision,
  // but JS Date only carries milliseconds — a getAt({at}) call round-trips a Date the caller
  // read back from a prior write, and without this truncation the reconstructed instant is
  // silently EARLIER than the true microsecond-precision valid_from, missing the row entirely
  // (Law T4 broken in practice, not just the already-documented visibility-timestamp caveat).
  // Truncating at write time makes the stored value and its JS Date round-trip bit-for-bit
  // identical, so containment lookups by a round-tripped Date always match. Residual caveat:
  // two writes to the SAME key in different transactions landing within the same millisecond
  // now collide (valid_from = valid_to for the older write) and raise 23514 (ClockRegressionError)
  // — narrower and far rarer than the bug this replaces, and documented in Formal/STORAGE_ALGEBRA.md
  // §1's Law T4 caveat rather than silently accepted.
  await sql`
    CREATE TABLE ${sql(schema)}.kv_current (
      ns           text NOT NULL,
      scope        text NOT NULL,
      key          text NOT NULL,
      value        jsonb NOT NULL,
      version      bigint NOT NULL,
      updated_at   timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
      updated_xact bigint NOT NULL DEFAULT txid_current(),
      PRIMARY KEY (ns, scope, key)
    )
  `;

  await sql`
    CREATE TABLE ${sql(schema)}.kv_history (
      id         bigserial PRIMARY KEY,
      ns         text NOT NULL,
      scope      text NOT NULL,
      key        text NOT NULL,
      value      jsonb NOT NULL,
      version    bigint NOT NULL,
      valid_from timestamptz NOT NULL,
      valid_to   timestamptz NOT NULL,
      validity   tstzrange GENERATED ALWAYS AS (tstzrange(valid_from, valid_to, '[)')) STORED,
      CONSTRAINT kv_history_range CHECK (valid_from < valid_to),
      CONSTRAINT kv_history_no_overlap EXCLUDE USING gist (
        ns WITH =, scope WITH =, key WITH =, validity WITH &&
      )
    )
  `;

  await sql`
    CREATE INDEX kv_history_lookup ON ${sql(schema)}.kv_history (ns, scope, key, valid_from)
  `;

  // Covering index for the {version} addressing path — kv_history_lookup above is ordered for
  // the {at} timestamp path (valid_from), not this one.
  await sql`
    CREATE INDEX kv_history_by_version ON ${sql(schema)}.kv_history (ns, scope, key, version)
  `;

  await sql`
    CREATE OR REPLACE FUNCTION ${sql(schema)}.kv_current_history_trigger() RETURNS trigger
    LANGUAGE plpgsql AS $trigger$
    DECLARE
      now_xact bigint := txid_current();
      now_ts   timestamptz := date_trunc('milliseconds', clock_timestamp());
    BEGIN
      IF OLD.updated_xact = now_xact THEN
        RAISE EXCEPTION USING
          ERRCODE = 'UB001',
          MESSAGE = format('kv_current: only one write per key is allowed per transaction (ns=%s, scope=%s, key=%s)', OLD.ns, OLD.scope, OLD.key);
      END IF;
      INSERT INTO ${sql(schema)}.kv_history (ns, scope, key, value, version, valid_from, valid_to)
      VALUES (OLD.ns, OLD.scope, OLD.key, OLD.value, OLD.version, OLD.updated_at, now_ts);
      NEW.updated_at   := now_ts;
      NEW.updated_xact := now_xact;
      RETURN NEW;
    END;
    $trigger$ SET search_path = pg_catalog, ${sql(schema)}
  `;

  await sql`
    CREATE TRIGGER kv_current_history_bu
      BEFORE UPDATE ON ${sql(schema)}.kv_current
      FOR EACH ROW
      EXECUTE FUNCTION ${sql(schema)}.kv_current_history_trigger()
  `;
}
