import type { ISql } from "postgres";

/**
 * `transaction_history` DDL (`openspec/changes/sprint-7-transaction-history-storage/design.md`
 * §1). Every identifier is schema-qualified via `sql(schema)`, matching every prior migration's
 * established pattern.
 *
 * `identifiers`/`lifecycle` are denormalized OUT of `entry` (rather than only living inside the
 * JSONB) so the identifier-subset pending-clear rule
 * (`src/postgres/transaction-history-storage.ts`) can be checked with a GIN-indexed containment
 * query (`identifiers <@ ...`) instead of a JSONB path scan on every finalize/reject write, and so
 * a caller can filter by lifecycle without unpacking `entry`. `lifecycle` stores only the
 * discriminant (`entry`'s own `lifecycle.status`) — the full lifecycle object (room for
 * per-status detail) lives in `entry` itself. Both columns are written together with `entry` in
 * the same statement, so they never drift out of sync with it.
 *
 * No `serialize()`-specific column: `serialize()` is a full dump per the interface's fixed
 * `Promise<string>` contract, implemented as `getAll()` + `JSON.stringify`, not a stored
 * representation.
 */
export const name = "004_transaction_history";

export async function up(sql: ISql, schema: string): Promise<void> {
  await sql`
    CREATE TABLE ${sql(schema)}.transaction_history (
      wallet_id   text        NOT NULL,
      tx_hash     text        NOT NULL,
      entry       jsonb       NOT NULL,
      identifiers text[]      NOT NULL DEFAULT '{}',
      lifecycle   text        NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (wallet_id, tx_hash)
    )
  `;

  // Default GIN opclass for an array column (array_ops) supports both containment operators
  // (<@, @>) this module's identifier-subset pending-clear query needs -- no explicit opclass
  // required.
  await sql`
    CREATE INDEX transaction_history_identifiers_gin
      ON ${sql(schema)}.transaction_history USING gin (identifiers)
  `;
}
