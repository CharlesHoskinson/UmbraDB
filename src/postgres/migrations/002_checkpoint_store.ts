import type { ISql } from "postgres";

/**
 * `ckpt_chunks`/`ckpt_manifests`/`ckpt_manifest_chunks`/`ckpt_sequence_counters` DDL
 * (`openspec/changes/sprint-3-checkpoint-store/design.md` §2/§6, `design/design.md` §3). Every
 * identifier is schema-qualified via `sql(schema)`, matching `001_temporal_kv.ts`'s established
 * pattern. No trigger, no extension — unlike TemporalKV, this module needs neither.
 */
export const name = "002_checkpoint_store";

export async function up(sql: ISql, schema: string): Promise<void> {
  await sql`
    CREATE TABLE ${sql(schema)}.ckpt_chunks (
      hash       bytea PRIMARY KEY,
      data       bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  // manifest_hash/label (openspec/changes/sprint-3-checkpoint-store/design.md §5) are additions
  // to design/design.md §3's original ckpt_manifests columns: manifest_hash is a SHA-256 over
  // the position-ordered chunk-hash sequence, computed once at save() time so load()/history()
  // never need to recompute it from the junction table; label is the caller-supplied free-text
  // label SaveCheckpointOptionsSchema documents as "surfaced in history()".
  await sql`
    CREATE TABLE ${sql(schema)}.ckpt_manifests (
      id            bigserial PRIMARY KEY,
      w             text NOT NULL,
      net           text NOT NULL,
      seq           bigint NOT NULL,
      complete      boolean NOT NULL DEFAULT false,
      manifest_hash bytea NOT NULL,
      label         text,
      created_at    timestamptz NOT NULL DEFAULT now()
    )
  `;

  // Compound index for the prune/list-descending access pattern (design/design.md §3).
  await sql`
    CREATE INDEX ckpt_manifests_lookup
      ON ${sql(schema)}.ckpt_manifests (w, net, complete, seq DESC)
  `;

  // position column and manifest_id's ON DELETE CASCADE are corrections to design/design.md §3's
  // original junction table (openspec/changes/sprint-3-checkpoint-store/design.md §2.1):
  // - position: PRIMARY KEY (manifest_id, chunk_hash) alone cannot represent a manifest
  //   referencing the same chunk hash at two different positions (a real repeated-content-run
  //   payload would silently lose bytes on reconstruction). Keying on (manifest_id, position)
  //   instead admits that case; chunk_hash is a plain FK column, not part of the PK.
  // - ON DELETE CASCADE: without it, prune's manifest DELETE (002 below has no DDL for prune
  //   itself, see checkpoint-store.ts) raises SQLSTATE 23503 for every manifest that still has
  //   junction rows referencing it -- i.e. every manifest ever saved -- so GC could never delete
  //   a single manifest. CASCADE removes the junction rows in the same statement as the manifest
  //   delete, which is also what makes them invisible to the chunk-reclaim query's NOT EXISTS
  //   check in the same GC pass.
  await sql`
    CREATE TABLE ${sql(schema)}.ckpt_manifest_chunks (
      manifest_id bigint  NOT NULL REFERENCES ${sql(schema)}.ckpt_manifests(id) ON DELETE CASCADE,
      position    integer NOT NULL,
      chunk_hash  bytea   NOT NULL REFERENCES ${sql(schema)}.ckpt_chunks(hash),
      PRIMARY KEY (manifest_id, position)
    )
  `;

  await sql`
    CREATE INDEX ckpt_manifest_chunks_by_hash
      ON ${sql(schema)}.ckpt_manifest_chunks (chunk_hash)
  `;

  // Sequence allocator (openspec/changes/sprint-3-checkpoint-store/design.md §2.2): design/
  // design.md §3 declares ckpt_manifests.seq but never specifies how a caller-visible, monotonic-
  // per-(w,net) sequence number is actually allocated race-free. This table backs an atomic
  // upsert-increment claim (see checkpoint-store.ts's save()): DEFAULT 2 so the first-ever claim
  // for a (w, net) pair (the INSERT branch) reports RETURNING next_seq - 1 = 1, matching the
  // interface's documented "start at 1."
  await sql`
    CREATE TABLE ${sql(schema)}.ckpt_sequence_counters (
      w        text   NOT NULL,
      net      text   NOT NULL,
      next_seq bigint NOT NULL DEFAULT 2,
      PRIMARY KEY (w, net)
    )
  `;
}
