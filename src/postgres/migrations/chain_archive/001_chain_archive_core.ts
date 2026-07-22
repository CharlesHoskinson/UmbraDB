import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";
import { CHAIN_ARCHIVE_HEIGHT_PARTITION_SIZE, CHAIN_ARCHIVE_PRECREATED_PARTITIONS } from "./partition-config.js";

/**
 * `chain_blobs` / `chain_blob_roles` / `blocks` / `transactions` / `bridge_observations` /
 * `verifier_key_observations` / `watermarks` DDL for the **Tier-1.5 chain-archive lineage**
 * (`design/full-chain-storage-design.md` §4/§5/§7, revised in response to the 3-reviewer
 * design-council audit — Fable 5 / Opus / GPT-5.6 Sol — that found the original
 * `005_chain_archive.ts` had a fork-breaking PK bug, unenforced canonical-chain uniqueness, an
 * unjustified `block_undo` table, a silent bridge-data survival hole, and several smaller
 * schema gaps; see the design doc's revision-history note for the full list).
 *
 * **v3 revision (round-2 design-council re-audit — Fable 5 / Opus / GPT-5.6 Sol; see the design
 * doc's "Revision history — v3" note for the full writeup):**
 *   1. `blocks` gained `CHECK (NOT finalized OR is_canonical)` — closes a gap the v2 `(status =
 *      'canonical') = is_canonical` CHECK didn't cover (finalized-but-not-canonical was legal).
 *   2. `chain_blob_roles` completeness is now DB-enforced, not merely conventional: every table
 *      that references `chain_blobs(hash)` (`blocks.header_blob_hash`/`body_blob_hash`,
 *      `transactions.raw_blob_hash`, `bridge_observations.raw_blob_hash`,
 *      `verifier_key_observations.vk_hash`) has a `BEFORE INSERT OR UPDATE` trigger requiring a
 *      matching `chain_blob_roles` row to already exist for the role that column implies.
 *      **Empirically confirmed** against a real Postgres 17 instance while revising this
 *      migration: a `BEFORE INSERT FOR EACH ROW` trigger defined on a `PARTITION BY RANGE`
 *      parent table is automatically cloned onto every existing AND future partition (confirmed
 *      via `pg_trigger`), and correctly rejects an insert whose referenced blob has no matching
 *      role row while accepting one that does.
 *   3. `verifier_keys` split into `verifier_key_observations` (§4.5's redesign) — see that
 *      table's own comment block for the full reasoning, grounded in reading
 *      `transient-crypto/src/proofs.rs` and `ledger/src/structure.rs` directly.
 *   4. `transactions.protocol_version` gained a `CHECK (protocol_version >= 0)` (closes a gap
 *      in the v2 "nonnegative checks throughout" claim); the redundant `transactions_by_block`
 *      index (a strict left-prefix of the existing PK index) was dropped.
 *   5. The `blocks`/`transactions`/`bridge_observations` DEFAULT-partition rollover runbook
 *      (design doc §4.6) was rewritten around an empirically-verified DETACH/re-ATTACH
 *      procedure — the v2 runbook's copy-then-delete-from-DEFAULT step is provably broken by
 *      the very FKs this feature added (confirmed by reproducing the exact failure: `DELETE`
 *      from a DEFAULT partition that still holds FK-referenced rows is rejected). No schema
 *      change was needed for this fix — see the design doc for the corrected runbook.
 *
 * This migration is applied to its **own** schema (conventionally `chain_archive`, but the
 * schema name is passed in by the caller exactly like every other migration in this repo) via
 * `chainArchiveMigrations` (`./index.ts`), NOT via `tier1WalletMigrations` — chain-scoped
 * archival data does not belong inside `tier1_wallet` (`design/design.md` §0; wallet/checkpoint
 * persistence only), and it is deliberately NOT the Tier-2 indexer-schema fork either. Like
 * every migration in this repo, this file is schema-qualified via `sql(schema)` and does not
 * hardcode a schema name.
 *
 * **Not wired into any runner path that would execute it.** `chainArchiveMigrations` is a
 * plain exported array — nothing in this repo's actual application code calls
 * `runMigrations(sql, { schema: "chain_archive", migrations: chainArchiveMigrations })` today.
 * This remains a design-stage artifact exactly as `005_chain_archive.ts` was before it, per the
 * task's explicit scope.
 */
export const name = "001_chain_archive_core";

export async function up(sql: ISql, schema: string): Promise<void> {
  // Defense-in-depth re-check, matching `client.ts`'s own stated rationale for why
  // `assertValidSchemaName` exists as a second gate beyond `sql()`'s own escaping: this
  // function below uses `sql.unsafe()` for the partition-bound DDL (postgres.js's tagged-
  // template bind-param path cannot type a bare parameter marker in a `PARTITION ... FOR
  // VALUES FROM/TO` position — confirmed empirically against a real Postgres 17 instance while
  // revising this migration; see the design doc §4.6 for the full empirical writeup), which
  // means the schema name is interpolated into that raw string by hand rather than through
  // `sql(schema)`'s identifier escaping. `runMigrations` (`../../migrate.ts`) already validates
  // `opts.schema` before any migration runs, so this call is redundant in that path — it exists
  // so this migration is still safe to call directly, bypassing the runner, the same way every
  // other migration's `up()` already assumes a schema-qualified `sql(schema)` call would fail
  // loudly on a malformed name rather than assuming the caller always validated first.
  assertValidSchemaName(schema);

  // ---------------------------------------------------------------------------------------
  // chain_blobs — content-addressed blob store (unchanged sibling-to-ckpt_chunks decision,
  // §4.1; all three reviewers praised this split and it is kept as-is). Two revisions from the
  // original: (1) `size_bytes` is now a generated column instead of a caller-supplied value
  // that could silently disagree with `data`'s real length; (2) `hash` gets an explicit
  // fixed-length CHECK (SHA-256 = 32 bytes) instead of trusting content unconditionally.
  // Empirically confirmed against a real Postgres 17 instance while revising this migration:
  // `GENERATED ALWAYS AS (octet_length(data)) STORED` computes and stores correctly, and the
  // length CHECK correctly rejects a short value.
  // ---------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE ${sql(schema)}.chain_blobs (
      hash       bytea PRIMARY KEY CHECK (octet_length(hash) = 32),
      data       bytea NOT NULL,
      size_bytes integer GENERATED ALWAYS AS (octet_length(data)) STORED,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  // `kind` is REMOVED from chain_blobs itself (was a NOT NULL single-valued CHECK column) and
  // replaced with this many-to-many role table. Reviewer-flagged contradiction in the original:
  // the design doc's own §4.1 argued identical content can correctly serve multiple logical
  // roles (and that deduplicating such a collision is correct, not a bug) while simultaneously
  // storing a single required `kind` enum value per row — a blob whose bytes are later reused
  // under a second role would either violate the row's fixed classification or silently mis-
  // report it. This table lets one hash carry N roles without contradiction; the filter/
  // diagnostic use case the old `chain_blobs_kind` index served is preserved via
  // `chain_blob_roles_by_role` below.
  await sql`
    CREATE TABLE ${sql(schema)}.chain_blob_roles (
      blob_hash bytea NOT NULL REFERENCES ${sql(schema)}.chain_blobs(hash),
      role      text  NOT NULL CHECK (role IN ('block_header', 'block_body', 'tx_raw', 'proof', 'verifier_key', 'bridge_observation')),
      PRIMARY KEY (blob_hash, role)
    )
  `;

  await sql`
    CREATE INDEX chain_blob_roles_by_role
      ON ${sql(schema)}.chain_blob_roles (role)
  `;

  // ---------------------------------------------------------------------------------------
  // chain_archive_assert_blob_role — v3 audit fix, blob-role integrity (flagged by 2 of 3
  // round-2 reviewers). Before this, `chain_blob_roles` could legally have zero rows for a
  // `chain_blobs` hash that `blocks`/`transactions`/`bridge_observations`/
  // `verifier_key_observations` reference directly — a real regression from the pre-v2 `kind
  // NOT NULL` column, which guaranteed every blob was classified. Chose enforcement (option
  // (a) from the audit's menu, not documenting role-tagging as advisory-only) because it
  // empirically turned out not to be excessively complex: one shared helper function plus one
  // thin `BEFORE INSERT OR UPDATE` trigger per consuming table/column, verified against a real
  // Postgres 17 instance to (1) correctly reject a reference to an unclassified blob and (2)
  // correctly propagate from the partitioned parent to every partition automatically (PG11+
  // behavior — row triggers on a partitioned table are cloned onto existing and future
  // partitions, not something that must be redeclared per-partition).
  //
  // This is an insert/update-time invariant, not a delete-time one: nothing in this schema ever
  // deletes a `chain_blob_roles` row (consistent with the rest of this design's insert-only
  // model, §6), so there is no corresponding trigger guarding against a role being removed out
  // from under an existing reference — that gap doesn't exist today because no code path
  // creates it.
  // ---------------------------------------------------------------------------------------
  await sql`
    CREATE FUNCTION ${sql(schema)}.chain_archive_assert_blob_role(
      p_blob_hash bytea, p_role text, p_table text, p_column text
    ) RETURNS void LANGUAGE plpgsql AS $fn$
    BEGIN
      IF p_blob_hash IS NULL THEN
        RETURN;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM ${sql(schema)}.chain_blob_roles
        WHERE blob_hash = p_blob_hash AND role = p_role
      ) THEN
        RAISE EXCEPTION 'blob % referenced by %.% has no chain_blob_roles row for role %'
          , encode(p_blob_hash, 'hex'), p_table, p_column, p_role
          USING ERRCODE = '23514'; -- check_violation: a classification-completeness failure,
                                    -- not a generic runtime error
      END IF;
    END;
    $fn$
  `;

  // ---------------------------------------------------------------------------------------
  // blocks — the block tree, not just the canonical chain (§4.2; kept as all three reviewers
  // praised this modeling choice). Revisions from the original:
  //   1. FORK-BREAKING PK BUG FIX (caught independently by 2 of 3 reviewers): this table's PK
  //      already included `block_hash` — the bug was in `transactions` (below), which omitted
  //      it. `blocks`' own `(net, height, block_hash)` PK is unchanged in shape, just gains
  //      `net` (point 4 below).
  //   2. Canonical-uniqueness enforcement: a `CHECK` ties `status`/`is_canonical` together so
  //      they cannot diverge, and a partial UNIQUE index enforces at most one canonical block
  //      per `(net, height)`. **Empirically verified against a real Postgres 17 instance**
  //      while revising this migration (full transcript in the design doc §4.2): a partial
  //      unique index `ON blocks (net, height) WHERE is_canonical`, on a table
  //      `PARTITION BY RANGE (height)`, is accepted by Postgres BECAUSE the index includes the
  //      partition key column (`height`) — Postgres implements it as one native "partitioned
  //      index" with a matching valid child index automatically created on every existing and
  //      future partition (confirmed via `\d+`/`pg_indexes`/`pg_index.indisvalid`), and it DOES
  //      enforce genuine cross-partition-equivalent uniqueness: since `height` is the partition
  //      key, two rows sharing the same `height` value can only ever land in the same physical
  //      partition by construction, so per-partition local enforcement IS global enforcement
  //      for this key. As a negative control, the same test confirmed Postgres unconditionally
  //      REJECTS a partial unique index on this table that omits the partition key column
  //      (error: "unique constraint on partitioned table must include all partitioning
  //      columns") — so one reviewer's claim that partial unique indexes "don't work" on
  //      partitioned tables is refuted for this case (they do, and enforce correctly, as long
  //      as the partition key is included), while the other reviewer's claim that this works
  //      "because height maps 1:1 to a partition" is exactly right and is the reason it's
  //      correct, not a coincidence.
  //   3. Nonnegative/fixed-length sanity CHECKs on `height` and the three hash columns.
  //   4. `net` (network/genesis-identity dimension, matching the existing `net` column
  //      convention in `002_checkpoint_store.ts`/`checkpoint-store.ts`) — nothing before this
  //      stopped two different networks' archive data from being silently comingled in one
  //      archive. Folded into the PK alongside the existing partition key (`height`) and
  //      `block_hash`.
  // `parent_hash` remains without an FK (documented rationale unchanged from the original: a
  // self-referencing FK across range partitions complicates out-of-order reorg backfill,
  // parent-link integrity is an application-level invariant). `body_blob_hash` remains nullable
  // pending body/extrinsics sync (unchanged) — see the design doc §6 for why this no longer
  // blocks bridge-data archival despite that.
  // ---------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE ${sql(schema)}.blocks (
      net              text        NOT NULL,
      block_hash       bytea       NOT NULL CHECK (octet_length(block_hash) = 32),
      height           bigint      NOT NULL CHECK (height >= 0),
      parent_hash      bytea       NOT NULL CHECK (octet_length(parent_hash) = 32),
      state_root       bytea       NOT NULL CHECK (octet_length(state_root) = 32),
      extrinsics_root  bytea       NOT NULL CHECK (octet_length(extrinsics_root) = 32),
      author           bytea,
      header_blob_hash bytea       NOT NULL REFERENCES ${sql(schema)}.chain_blobs(hash),
      body_blob_hash   bytea       REFERENCES ${sql(schema)}.chain_blobs(hash),
      is_canonical     boolean     NOT NULL DEFAULT false,
      status           text        NOT NULL DEFAULT 'seen' CHECK (status IN ('seen', 'canonical', 'orphaned', 'pruned')),
      finalized        boolean     NOT NULL DEFAULT false,
      synced_at        timestamptz NOT NULL DEFAULT now(),
      CHECK ((status = 'canonical') = is_canonical),
      -- v3 audit fix (2 of 3 round-2 reviewers): the CHECK above only ties status/is_canonical
      -- together, leaving finalized=true, status='seen', is_canonical=false legal -- impossible
      -- under real Substrate/GRANDPA finality semantics (a finalized block is always
      -- canonical). finalized implies is_canonical (equivalently NOT finalized OR is_canonical)
      -- closes it; empirically confirmed against a real Postgres 17 instance while revising
      -- this migration to both (a) reject the illegal combination and (b) still accept every
      -- legal one (seen/not-canonical/not-finalized; canonical/finalized;
      -- canonical/not-yet-finalized).
      CHECK (NOT finalized OR is_canonical),
      PRIMARY KEY (net, height, block_hash)
    ) PARTITION BY RANGE (height)
  `;

  await createHeightPartitions(sql, schema, "blocks");

  await sql`
    CREATE UNIQUE INDEX blocks_one_canonical_per_height
      ON ${sql(schema)}.blocks (net, height) WHERE is_canonical
  `;
  await sql`
    CREATE INDEX blocks_by_hash
      ON ${sql(schema)}.blocks (block_hash)
  `;
  await sql`
    CREATE INDEX blocks_by_parent
      ON ${sql(schema)}.blocks (parent_hash)
  `;

  // v3 audit fix — blob-role integrity (see chain_archive_assert_blob_role above). `blocks` has
  // two blob-hash columns: `header_blob_hash` (NOT NULL, always checked) and `body_blob_hash`
  // (nullable, checked only when present -- the helper function itself no-ops on NULL).
  await sql`
    CREATE FUNCTION ${sql(schema)}.blocks_check_blob_roles() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      PERFORM ${sql(schema)}.chain_archive_assert_blob_role(
        NEW.header_blob_hash, 'block_header', 'blocks', 'header_blob_hash');
      PERFORM ${sql(schema)}.chain_archive_assert_blob_role(
        NEW.body_blob_hash, 'block_body', 'blocks', 'body_blob_hash');
      RETURN NEW;
    END;
    $fn$
  `;
  await sql`
    CREATE TRIGGER blocks_blob_roles_trigger
      BEFORE INSERT OR UPDATE OF header_blob_hash, body_blob_hash ON ${sql(schema)}.blocks
      FOR EACH ROW EXECUTE FUNCTION ${sql(schema)}.blocks_check_blob_roles()
  `;

  // ---------------------------------------------------------------------------------------
  // transactions — metadata only, raw bytes via blob reference (§4.3). THE FORK-BREAKING PK
  // FIX (§1 of the audit): the original PK was `(block_height, tx_hash)`, omitting
  // `block_hash` entirely — since `blocks` correctly models the full block tree (competing
  // blocks at the same height), two forks both containing transaction T at the same height
  // collided on this PK, making it impossible to store both forks' inclusion records. Fixed by
  // making the PK `(net, block_height, block_hash, tx_hash)` — every column a transaction
  // inclusion record actually needs to be unique per (network, fork, transaction). A separate
  // `UNIQUE (net, block_height, block_hash, position)` constraint additionally prevents two
  // transactions from occupying the same slot within one block (requested independently of the
  // PK fix). A real FK to `blocks` (missing before; flagged by reviewers as "permits
  // transactions attached to nonexistent or height-mismatched blocks") is now enforced —
  // **empirically confirmed working** against a real Postgres 17 instance while revising this
  // migration: an FK from one range-partitioned table to another, both partitioned on columns
  // in the same domain (`block_height` here referencing `blocks.height`), is accepted and
  // correctly rejects both a reference to a nonexistent block and a reference where
  // `block_height`/`block_hash` don't jointly match any real `blocks` row (tested both cases
  // directly; see the design doc §4.3 for the transcript).
  // ---------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE ${sql(schema)}.transactions (
      net              text        NOT NULL,
      tx_hash          bytea       NOT NULL CHECK (octet_length(tx_hash) = 32),
      block_height     bigint      NOT NULL CHECK (block_height >= 0),
      block_hash       bytea       NOT NULL CHECK (octet_length(block_hash) = 32),
      position         integer     NOT NULL CHECK (position >= 0),
      kind             text        NOT NULL CHECK (kind IN ('regular', 'system')),
      -- v3 audit fix (minor item 6): the v2 design doc claimed "nonnegative checks throughout"
      -- but this column had none -- added to actually match that claim.
      protocol_version integer     NOT NULL CHECK (protocol_version >= 0),
      result           text        CHECK (result IN ('success', 'partial_success', 'failure') OR result IS NULL),
      raw_blob_hash    bytea       NOT NULL REFERENCES ${sql(schema)}.chain_blobs(hash),
      synced_at        timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (net, block_height, block_hash, tx_hash),
      UNIQUE (net, block_height, block_hash, position),
      FOREIGN KEY (net, block_height, block_hash) REFERENCES ${sql(schema)}.blocks (net, height, block_hash)
    ) PARTITION BY RANGE (block_height)
  `;

  await createHeightPartitions(sql, schema, "transactions", "block_height");

  await sql`
    CREATE INDEX transactions_by_hash
      ON ${sql(schema)}.transactions (tx_hash)
  `;
  // v3 audit fix (minor item 6): `transactions_by_block` (ON (net, block_height, block_hash))
  // dropped -- it is a strict left-prefix of the PK's own btree index (net, block_height,
  // block_hash, tx_hash), so Postgres can already satisfy any (net) / (net, block_height) /
  // (net, block_height, block_hash) lookup or the FK's own existence checks off the PK index
  // directly; the separate index bought no distinct access pattern, only extra write-amplification
  // and storage. `transactions_by_hash` (above) is kept -- it is NOT a PK left-prefix (`tx_hash`
  // alone, not `(net, block_height, block_hash, tx_hash)`), and is the genuinely distinct
  // "look up a transaction by hash alone, across all blocks/forks" access pattern.

  // v3 audit fix — blob-role integrity (see chain_archive_assert_blob_role above).
  await sql`
    CREATE FUNCTION ${sql(schema)}.transactions_check_blob_roles() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      PERFORM ${sql(schema)}.chain_archive_assert_blob_role(
        NEW.raw_blob_hash, 'tx_raw', 'transactions', 'raw_blob_hash');
      RETURN NEW;
    END;
    $fn$
  `;
  await sql`
    CREATE TRIGGER transactions_blob_roles_trigger
      BEFORE INSERT OR UPDATE OF raw_blob_hash ON ${sql(schema)}.transactions
      FOR EACH ROW EXECUTE FUNCTION ${sql(schema)}.transactions_check_blob_roles()
  `;

  // ---------------------------------------------------------------------------------------
  // bridge_observations — NEW build-now table (§3 of the audit / design doc §6). The original
  // design deferred bridge/governance data on two grounds: (a) "the indexer already has it" —
  // acknowledged by reviewers as not a real justification for a store that exists specifically
  // to survive an indexer wipe, and (b) "replay-recoverable from raw transaction bytes" — never
  // actually tested, and contradicted by the design doc's OWN §3.7/§9 observations: bridge
  // observations (cnight registrations, D-parameter/system-parameter updates) are carried in
  // Substrate INHERENTS, which live in the block BODY, not in `transactions`; `blocks.
  // body_blob_hash` is nullable "until body/extrinsics sync lands"; and the doc itself notes
  // this category is "partly Cardano-side... not cleanly re-derivable from Midnight block
  // replay alone." Reclassified to build-now: a lean table following the exact same
  // "queryable metadata + blob reference" pattern as `transactions` — `raw_blob_hash` points at
  // the specific observation's own raw bytes (registered under the `chain_blob_roles`
  // `'bridge_observation'` role), independent of whether full block-body sync exists yet, so
  // this does not wait on that unrelated, unscheduled dependency.
  // ---------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE ${sql(schema)}.bridge_observations (
      net               text        NOT NULL,
      block_height      bigint      NOT NULL CHECK (block_height >= 0),
      block_hash        bytea       NOT NULL CHECK (octet_length(block_hash) = 32),
      observation_index integer     NOT NULL CHECK (observation_index >= 0),
      kind              text        NOT NULL CHECK (kind IN ('cnight_registration', 'system_parameters_d', 'spo_registration', 'other')),
      raw_blob_hash     bytea       NOT NULL REFERENCES ${sql(schema)}.chain_blobs(hash),
      synced_at         timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (net, block_height, block_hash, observation_index),
      FOREIGN KEY (net, block_height, block_hash) REFERENCES ${sql(schema)}.blocks (net, height, block_hash)
    ) PARTITION BY RANGE (block_height)
  `;

  await createHeightPartitions(sql, schema, "bridge_observations", "block_height");

  await sql`
    CREATE INDEX bridge_observations_by_kind
      ON ${sql(schema)}.bridge_observations (kind)
  `;

  // v3 audit fix — blob-role integrity (see chain_archive_assert_blob_role above).
  await sql`
    CREATE FUNCTION ${sql(schema)}.bridge_observations_check_blob_roles() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      PERFORM ${sql(schema)}.chain_archive_assert_blob_role(
        NEW.raw_blob_hash, 'bridge_observation', 'bridge_observations', 'raw_blob_hash');
      RETURN NEW;
    END;
    $fn$
  `;
  await sql`
    CREATE TRIGGER bridge_observations_blob_roles_trigger
      BEFORE INSERT OR UPDATE OF raw_blob_hash ON ${sql(schema)}.bridge_observations
      FOR EACH ROW EXECUTE FUNCTION ${sql(schema)}.bridge_observations_check_blob_roles()
  `;

  // ---------------------------------------------------------------------------------------
  // verifier_key_observations — v3 audit fix (new finding, round-2 reviewer, confirmed against
  // ledger source). Replaces the v2 single `verifier_keys` table, which had two real gaps:
  //
  // (a) its CHECK only enforced `scope='contract' => contract_address IS NOT NULL`, not the
  //     full "iff" the v2 design doc's own comment claimed (`contract_address IS NOT NULL <=>
  //     scope='contract'`) -- a protocol-scoped row with a non-null `contract_address` was
  //     silently accepted. Fixed below with `CHECK ((scope = 'contract') = (contract_address IS
  //     NOT NULL))`, enforcing both directions -- empirically confirmed against a real Postgres
  //     17 instance to reject BOTH illegal combinations (protocol+non-null address,
  //     contract+null address) while accepting both legal ones.
  //
  // (b) `PRIMARY KEY (vk_hash)` alone was too narrow. Confirmed by reading
  //     `transient-crypto/src/proofs.rs` and `ledger/src/structure.rs` directly (not assumed):
  //     `VerifierKey`'s content-addressed bytes are a pure function of the compiled circuit
  //     (`MidnightVK`, written via `SerdeFormat::Processed` with no network/contract/address
  //     salt anywhere in `VerifierKey::serialize`/`Tagged::tag` -- the tag is the fixed constant
  //     `"verifier-key[v6]"` for every instance, a format version marker, not a per-key
  //     identifier), and `structure.rs`'s `VerifierKeyInsert(EntryPointBuf,
  //     ContractOperationVersionedVerifierKey)` attaches a VK to a contract's own per-entry-point
  //     map -- nothing stops two different contract addresses (the same circuit/template
  //     deployed more than once) or two different networks (same protocol version) from
  //     genuinely sharing byte-identical VK content. A single-row-per-hash table cannot record
  //     more than one (net, scope, contract_address) context per key without either rejecting a
  //     real second sighting or overwriting the first one's context. Fixed by splitting the
  //     table in two:
  //       - The content-addressed half already exists and needed no new table: `chain_blobs`
  //         (hash -> bytes) IS "vk_hash -> key bytes," and `chain_blob_roles`
  //         (role = 'verifier_key') already tracks "this hash is known to be a VK" (the same
  //         mechanism the blob-role-integrity fix above introduced) -- building a third,
  //         redundant content-keyed table here would just duplicate that.
  //       - `verifier_key_observations` (below) is the new table: the "each place/context this
  //         key was actually seen" junction the audit asked for, keyed on
  //         `(vk_hash, net, scope, contract_address, first_seen_height)` per the task brief.
  //         That exact tuple cannot be a PRIMARY KEY, though -- Postgres requires every PK
  //         column to be NOT NULL, and `contract_address` is legitimately NULL for
  //         protocol-scoped rows, which would silently make protocol-scoped observations
  //         un-insertable. Uses a surrogate `id` PK plus `UNIQUE NULLS NOT DISTINCT
  //         (vk_hash, net, scope, contract_address, first_seen_height)` instead (PG15+, this
  //         repo targets PG17) -- **empirically confirmed** against a real Postgres 17 instance:
  //         two *different* protocol-scoped observations of the same key (different `net`, both
  //         `contract_address IS NULL`) are correctly accepted as distinct rows, while an exact
  //         duplicate context (same vk_hash/net/scope/contract_address/first_seen_height, both
  //         NULL `contract_address`) is correctly rejected -- ordinary `UNIQUE` treats every
  //         NULL as distinct from every other NULL and would NOT have caught that duplicate;
  //         `NULLS NOT DISTINCT` is what makes the dedup semantics actually match "one row per
  //         real observed context."
  //
  //     `tag` moved onto this table (not kept as a property of the content-addressed hash): it
  //     names the circuit/entry-point role a key was observed playing in a given context (e.g.
  //     which contract entry point inserted it), which is a property of the observation, not of
  //     the bytes themselves -- the same bytes observed in two different contexts could
  //     legitimately carry the same or different human-readable `tag`, so it belongs here.
  // ---------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE ${sql(schema)}.verifier_key_observations (
      id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      vk_hash           bytea       NOT NULL REFERENCES ${sql(schema)}.chain_blobs(hash),
      net               text        NOT NULL,
      scope             text        NOT NULL CHECK (scope IN ('protocol', 'contract')),
      tag               text        NOT NULL,
      contract_address  bytea,
      first_seen_height bigint      NOT NULL CHECK (first_seen_height >= 0),
      synced_at         timestamptz NOT NULL DEFAULT now(),
      CHECK ((scope = 'contract') = (contract_address IS NOT NULL)),
      UNIQUE NULLS NOT DISTINCT (vk_hash, net, scope, contract_address, first_seen_height)
    )
  `;

  await sql`
    CREATE INDEX verifier_key_observations_by_vk_hash
      ON ${sql(schema)}.verifier_key_observations (vk_hash)
  `;
  await sql`
    CREATE INDEX verifier_key_observations_by_contract
      ON ${sql(schema)}.verifier_key_observations (contract_address) WHERE contract_address IS NOT NULL
  `;

  // v3 audit fix — blob-role integrity (see chain_archive_assert_blob_role above).
  await sql`
    CREATE FUNCTION ${sql(schema)}.verifier_key_observations_check_blob_roles() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      PERFORM ${sql(schema)}.chain_archive_assert_blob_role(
        NEW.vk_hash, 'verifier_key', 'verifier_key_observations', 'vk_hash');
      RETURN NEW;
    END;
    $fn$
  `;
  await sql`
    CREATE TRIGGER verifier_key_observations_blob_roles_trigger
      BEFORE INSERT OR UPDATE OF vk_hash ON ${sql(schema)}.verifier_key_observations
      FOR EACH ROW EXECUTE FUNCTION ${sql(schema)}.verifier_key_observations_check_blob_roles()
  `;

  // ---------------------------------------------------------------------------------------
  // watermarks — chain_archive's OWN local watermark-equivalent table, NOT a reuse of
  // `tier1_wallet.watermarks` (§5 of the audit). The original design proposed reusing the
  // existing `watermarks` table (`003_watermarks.ts`) with a `kind='chain_archive'` row scoped
  // inside `tier1_wallet`. That table lives in, and is migration-owned by, the `tier1_wallet`
  // lineage — reaching across a schema boundary to write into it from `chain_archive`'s own
  // (structurally independent) lineage re-couples the two tiers this split exists to keep
  // apart (a chain_archive-only deployment/backup/restore could no longer be self-contained).
  // Same proven shape (kind/key/value pair, `fillfactor=90` for HOT-update-friendly high-
  // frequency cursor writes) as `003_watermarks.ts`, deliberately duplicated as a local,
  // independent table rather than cross-referenced.
  // ---------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE ${sql(schema)}.watermarks (
      kind       text NOT NULL,
      key        text NOT NULL,
      value      jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (kind, key)
    ) WITH (fillfactor = 90)
  `;
}

/**
 * Creates `CHAIN_ARCHIVE_PRECREATED_PARTITIONS` bounded partitions of
 * `CHAIN_ARCHIVE_HEIGHT_PARTITION_SIZE` blocks each, starting at height 0, plus one `DEFAULT`
 * catch-all (§4.6, §9's operational-rollover fix — pre-creating headroom instead of relying on
 * an unbounded `DEFAULT` from height 0).
 *
 * Uses `sql.unsafe()` for the partition-bound DDL, not a normal `sql` tagged-template call:
 * **empirically confirmed** while revising this migration (against a real Postgres 17
 * instance) that `postgres.js` cannot bind a `CREATE TABLE ... PARTITION OF ... FOR VALUES
 * FROM ($1) TO ($2)` parameter — Postgres itself rejects it at parse time with "could not
 * determine data type of parameter $1," because a partition bound is a constant-folded
 * expression the planner needs at DDL-parse time, not a bind-time value. This is safe despite
 * bypassing `sql`'s usual parameterization: `schema` is validated by `assertValidSchemaName`
 * (both by `runMigrations` before any migration runs, and redundantly at the top of this
 * migration's own `up()`) to match `^[a-z_][a-z0-9_]*$` and stay under Postgres's 63-byte
 * identifier limit, `tableBaseName` is always one of this file's own fixed string literals
 * (never external input), and the numeric bounds are computed from this module's own
 * `CHAIN_ARCHIVE_HEIGHT_PARTITION_SIZE`/`CHAIN_ARCHIVE_PRECREATED_PARTITIONS` constants — no
 * untrusted data ever reaches this string. Matches the one other place this repo already does
 * the same thing for the same reason (`transaction-lease.ts`'s `sql.unsafe("set local
 * statement_timeout = ...")`, needed there because `SET`'s value position has the identical
 * bind-param limitation).
 */
async function createHeightPartitions(
  sql: ISql, schema: string, tableBaseName: string, heightColumn = "height",
): Promise<void> {
  for (let i = 0; i < CHAIN_ARCHIVE_PRECREATED_PARTITIONS; i++) {
    const lo = i * CHAIN_ARCHIVE_HEIGHT_PARTITION_SIZE;
    const hi = (i + 1) * CHAIN_ARCHIVE_HEIGHT_PARTITION_SIZE;
    await sql.unsafe(
      `CREATE TABLE "${schema}".${tableBaseName}_p${i} ` +
      `PARTITION OF "${schema}".${tableBaseName} FOR VALUES FROM (${lo}) TO (${hi})`,
    );
  }
  await sql.unsafe(
    `CREATE TABLE "${schema}".${tableBaseName}_default ` +
    `PARTITION OF "${schema}".${tableBaseName} DEFAULT`,
  );
  // heightColumn is accepted for self-documentation at each call site (blocks partitions by
  // `height`, transactions/bridge_observations by `block_height`) even though the partition DDL
  // itself doesn't need to name the column again here — PARTITION BY RANGE(...) already fixed
  // it at CREATE TABLE time. Referenced here only so an unused-parameter lint can't flag it and
  // so a future reader has one place confirming which column each call is bucketing on.
  void heightColumn;
}
