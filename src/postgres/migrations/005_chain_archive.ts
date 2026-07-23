import type { ISql } from "postgres";

/**
 * `chain_blobs`/`blocks`/`transactions`/`block_undo`/`verifier_keys` DDL
 * (`design/full-chain-storage-design.md` §4, §7). Every identifier is schema-qualified via
 * `sql(schema)`, matching every prior migration's established pattern. This is a genuine,
 * syntactically-correct migration file -- but it is deliberately NOT added to `migrate.ts`'s
 * `migrations` array and has never been run against any database (`design/full-chain-storage-
 * design.md` §7's stated scope). Wiring it into the runner, choosing which schema it ultimately
 * lives in (see the design doc §9.1's open Tier-1/Tier-2 question), and any live apply are all
 * follow-up work gated on design-council review.
 *
 * Table-by-table rationale lives in the design doc; this file only restates the load-bearing DDL
 * decisions inline where a future reader would otherwise have to cross-reference to understand
 * why a line reads the way it does.
 */
export const name = "005_chain_archive";

export async function up(sql: ISql, schema: string): Promise<void> {
  // §4.1: a new sibling table, not `ckpt_chunks` + a `kind` column -- `ckpt_chunks`'s GC
  // correctness depends on every row being reachable only through `ckpt_manifest_chunks`;
  // chain-archive blobs have a permanent, unrelated lifecycle (referenced by range-partitioned
  // `blocks`/`transactions`/`verifier_keys` rows, never manifest-pruned). Same proven shape
  // (SHA-256 content-addressed PK, `bytea` payload) as `ckpt_chunks`, deliberately not merged
  // with it. `kind` is a filter/diagnostic column only, not part of the key -- content-addressing
  // means identical bytes always collapse to one row regardless of logical role.
  await sql`
    CREATE TABLE ${sql(schema)}.chain_blobs (
      hash       bytea PRIMARY KEY,
      kind       text  NOT NULL CHECK (kind IN ('block_header', 'block_body', 'tx_raw', 'proof', 'verifier_key')),
      data       bytea NOT NULL,
      size_bytes integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE INDEX chain_blobs_kind
      ON ${sql(schema)}.chain_blobs (kind)
  `;

  // §4.2: the block TREE, not just the canonical chain -- every received block is kept
  // (`is_canonical`/`status` distinguish canonical from orphaned/pruned), following the
  // Bitcoin-Core-derived recommendation in `design/full-chain-storage-design.md` §A/§5 rather
  // than Cardano db-sync's cascade-delete-on-reorg pattern. Range-partitioned by `height`
  // (§4.6) -- Postgres requires the partition key in any unique constraint on a partitioned
  // table, hence the compound `(height, block_hash)` primary key; `block_hash` global
  // uniqueness is trusted (SHA-256/Blake2 collision-negligibility), not DB-enforced, on the
  // same basis `ckpt_chunks`'s own PK already trusts. `parent_hash` deliberately has no FK --
  // a self-referencing FK across range partitions complicates out-of-order backfill during a
  // reorg-heavy resync (a child block can arrive before its parent is durably committed);
  // parent-link integrity is an application-level invariant, not a DB-enforced one, the same
  // trade this project already made for `ckpt_manifest_chunks`'s ordering guarantee.
  await sql`
    CREATE TABLE ${sql(schema)}.blocks (
      block_hash       bytea       NOT NULL,
      height           bigint      NOT NULL,
      parent_hash      bytea       NOT NULL,
      state_root       bytea       NOT NULL,
      extrinsics_root  bytea       NOT NULL,
      author           bytea,
      header_blob_hash bytea       NOT NULL REFERENCES ${sql(schema)}.chain_blobs(hash),
      body_blob_hash   bytea       REFERENCES ${sql(schema)}.chain_blobs(hash),
      is_canonical     boolean     NOT NULL DEFAULT false,
      status           text        NOT NULL DEFAULT 'seen' CHECK (status IN ('seen', 'canonical', 'orphaned', 'pruned')),
      finalized        boolean     NOT NULL DEFAULT false,
      synced_at        timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (height, block_hash)
    ) PARTITION BY RANGE (height)
  `;

  // One bounded partition + a DEFAULT catch-all: enough for the DDL to be immediately
  // insert-ready at any height. Operational partition rollover (creating the next bucket ahead
  // of time, migrating rows out of DEFAULT) is explicitly deferred to pg_partman or an
  // equivalent scheduled job (§4.6) -- not built in this pass.
  await sql`
    CREATE TABLE ${sql(schema)}.blocks_p0
      PARTITION OF ${sql(schema)}.blocks FOR VALUES FROM (0) TO (1000000)
  `;
  await sql`
    CREATE TABLE ${sql(schema)}.blocks_default
      PARTITION OF ${sql(schema)}.blocks DEFAULT
  `;

  await sql`
    CREATE INDEX blocks_by_hash
      ON ${sql(schema)}.blocks (block_hash)
  `;
  await sql`
    CREATE INDEX blocks_by_parent
      ON ${sql(schema)}.blocks (parent_hash)
  `;

  // §4.3: metadata only -- raw SCALE-encoded payload lives in chain_blobs via raw_blob_hash.
  // `kind`/`result` mirror the indexer's own live-confirmed `variant`/`transaction_result`
  // columns (`design/full-chain-storage-design.md` §3.3). No cross-table FK to `blocks`, same
  // range-partition/hot-path rationale as `blocks.parent_hash` above.
  await sql`
    CREATE TABLE ${sql(schema)}.transactions (
      tx_hash          bytea       NOT NULL,
      block_height     bigint      NOT NULL,
      block_hash       bytea       NOT NULL,
      position         integer     NOT NULL,
      kind             text        NOT NULL CHECK (kind IN ('regular', 'system')),
      protocol_version integer     NOT NULL,
      result           text        CHECK (result IN ('success', 'partial_success', 'failure') OR result IS NULL),
      raw_blob_hash    bytea       NOT NULL REFERENCES ${sql(schema)}.chain_blobs(hash),
      synced_at        timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (block_height, tx_hash)
    ) PARTITION BY RANGE (block_height)
  `;

  await sql`
    CREATE TABLE ${sql(schema)}.transactions_p0
      PARTITION OF ${sql(schema)}.transactions FOR VALUES FROM (0) TO (1000000)
  `;
  await sql`
    CREATE TABLE ${sql(schema)}.transactions_default
      PARTITION OF ${sql(schema)}.transactions DEFAULT
  `;

  await sql`
    CREATE INDEX transactions_by_hash
      ON ${sql(schema)}.transactions (tx_hash)
  `;
  await sql`
    CREATE INDEX transactions_by_block
      ON ${sql(schema)}.transactions (block_hash)
  `;

  // §4.4: reserved per-block diff-record shape, no cascade-delete anywhere in this schema.
  // `blocks`/`transactions` are pure insert-only (a reorg only flips `blocks.is_canonical`/
  // `status`, never deletes), so they need no undo record. This table exists for a FUTURE
  // mutable `*_current` projection (e.g. a materialized current-UTXO-set or current-contract-
  // state table -- both explicitly deferred, `design/full-chain-storage-design.md` §6) that
  // would need "apply stored inverse" rollback; `undo_blob_hash`'s payload format is
  // intentionally unspecified at v1.
  await sql`
    CREATE TABLE ${sql(schema)}.block_undo (
      block_height   bigint      NOT NULL,
      block_hash     bytea       NOT NULL,
      undo_blob_hash bytea       NOT NULL REFERENCES ${sql(schema)}.chain_blobs(hash),
      created_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (block_height, block_hash)
    ) PARTITION BY RANGE (block_height)
  `;

  await sql`
    CREATE TABLE ${sql(schema)}.block_undo_p0
      PARTITION OF ${sql(schema)}.block_undo FOR VALUES FROM (0) TO (1000000)
  `;
  await sql`
    CREATE TABLE ${sql(schema)}.block_undo_default
      PARTITION OF ${sql(schema)}.block_undo DEFAULT
  `;

  // §4.5: the one genuinely new archival surface -- the live indexer has no dedicated
  // verifier-key table today (`design/full-chain-storage-design.md` §6). Not range-partitioned:
  // VK count is bounded by (fixed protocol circuits) + (deployed contracts), nowhere near
  // block/tx volume.
  await sql`
    CREATE TABLE ${sql(schema)}.verifier_keys (
      vk_hash           bytea       PRIMARY KEY REFERENCES ${sql(schema)}.chain_blobs(hash),
      scope             text        NOT NULL CHECK (scope IN ('protocol', 'contract')),
      tag               text        NOT NULL,
      contract_address  bytea,
      first_seen_height bigint      NOT NULL,
      created_at        timestamptz NOT NULL DEFAULT now()
    )
  `;
}
