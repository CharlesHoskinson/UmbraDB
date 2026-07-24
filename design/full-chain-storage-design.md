# Full-Chain Storage — Design

**Branch:** `fix/full-chain-storage-schema-v2` (originally drafted on `feature/full-chain-storage`) · **Date:** 2026-07-22 · **Status:** Revised per 3-reviewer design-council audit, re-audited by a second independent 3-reviewer round and revised (v3), then re-audited by a third independent round — two of three reviewers reproduced real failures against real Postgres — and revised again (v4); schema-stage artifact, migration remains unregistered/inert, not yet applied to any live application DB.
**Author role:** synthesizing three completed research passes (industry archival prior art, Midnight source/schema audit, UmbraDB's live schema) plus a direct live-devnet confirmation pass, plus the v2/v3/v4 revisions' own direct empirical Postgres testing (real local `postgres:17-alpine`, not asserted from memory) and, for v3's verifier-key finding, direct reading of the Midnight ledger source.

## Revision history

### v4 — 2026-07-22, revised in response to a round-3 3-reviewer design-council re-audit (Opus / Fable 5 / GPT-5.6 Sol)

Opus called v3 STABLE. **Fable 5 and GPT-5.6 Sol both independently EMPIRICALLY REPRODUCED real failures against a real Postgres 17 instance and said NEEDS ANOTHER ROUND.** Their findings converge strongly. Every fix below was re-verified against a real local `postgres:17-alpine` container (not asserted from memory, not "prose-patched") — full transcripts summarized inline, exact commands in the sections referenced.

1. **The rollover runbook was fundamentally broken (CRITICAL — both reviewers independently reproduced this against real Postgres, top priority).** The v3 §4.6 DETACH-based procedure, as written, fails in four concrete, reproduced ways:
   - **Retained FK constraints block the parent detach.** After `ALTER TABLE transactions DETACH PARTITION transactions_default`, the now-standalone `transactions_default` table *keeps* its cloned FK constraint pointing at `blocks`. Detaching `blocks_default` next then fails with the exact same `foreign key constraint ... violates` error the whole procedure exists to work around — **reproduced verbatim**: `ERROR: removing partition "blocks_default" violates foreign key constraint "transactions_default_net_block_height_block_hash_fkey1" DETAIL: Key (net, block_height, block_hash)=(net1, 150, \x02) is still referenced from table "transactions_default".` Fix: drop the retained FK constraint on each detached child (a single `ALTER TABLE ... DROP CONSTRAINT` naming the constraint that matches the *original parent table's* own generated FK name — confirmed empirically that this cascades and drops the internal per-referenced-partition clones too, no need to enumerate them) **before** detaching the parent. Confirmed the FK is correctly re-established and validated on re-attach (§4.6 below).
   - **`duplicate_table` on "create new tables with the same names."** The v3 text only implied a rename; there was no actual rename command, and the detached relations genuinely still exist under their original names (`blocks_default`, etc.) until explicitly renamed — **reproduced**: attempting `CREATE TABLE blocks_default PARTITION OF blocks DEFAULT` right after detach, without renaming first, fails with `relation "blocks_default" already exists`. Fixed with an explicit `ALTER TABLE blocks_default RENAME TO blocks_default_staging` (and the same for the other two tables) as its own concrete step.
   - **A write-race window between resuming writes and attaching the new bounded partition.** The v3 procedure recreated `DEFAULT` (and so let writes resume) *before* re-attaching the staging data as bounded partitions, "for effectively zero downtime." **Reproduced the exact failure this creates**: with `blocks_default` live and `blocks_p1` not yet attached, a write landing at height 160 (inside the target `[100,200)` range) succeeds into `DEFAULT`; the subsequent `CREATE TABLE blocks_p1 PARTITION OF blocks FOR VALUES FROM (100) TO (200)` then fails with `ERROR: updated partition constraint for default partition "blocks_default" would be violated by some row`. **Fixed by reordering, not by adding a separate pause mechanism**: the corrected procedure does not recreate `DEFAULT` (and therefore does not let writes resume) until *after* every bounded partition needed for the just-detached data is already re-attached. During that window a write to an unbounded height fails loudly (no partition to route into) rather than racing silently — the safe outcome, and consistent with treating this as a "monitoring was missed" recovery path, not a routine operation. This also means the v3 doc's "effectively zero downtime" framing was wrong and has been removed; see also the next point.
   - **`DETACH PARTITION CONCURRENTLY` does not work in this scenario.** v3 mentioned it as an available fallback. **Reproduced directly**: `ALTER TABLE transactions DETACH PARTITION transactions_default CONCURRENTLY` (run as its own top-level statement, per its own requirement) fails immediately with `ERROR: cannot detach partitions concurrently when a default partition exists` — unconditionally, regardless of `transactions_default`'s size. Removed as a suggested option; §4.6 now states this caveat explicitly instead.
   - **`ATTACH`/`CREATE ... PARTITION OF` is not metadata-only/instant while a `DEFAULT` partition exists.** **Empirically timed**: attaching a brand-new, *empty*, non-overlapping bounded partition (`blocks_p2 FOR VALUES FROM (200) TO (300)`) while a concurrent session merely holds a `SHARE` lock on the table's (empty) `DEFAULT` partition blocks for the full duration of that lock (~12s in the test) before completing — direct proof Postgres must take a conflicting lock on (and scan) the `DEFAULT` partition to validate no existing row there violates the new bound, even when `DEFAULT` is empty and the new bound doesn't overlap anything currently in it. The design doc's cost/downtime claims are corrected accordingly — no longer stated as "effectively zero downtime" without qualification.

   §4.6 below is the fully rewritten, concrete, step-by-step procedure — every actual SQL command, not paraphrased — **run end-to-end against a real Postgres 17 container** (schema built matching `blocks`/`transactions`/`bridge_observations`'s real shape and FKs, `DEFAULT` partitions pre-populated with overflow rows beyond the only bounded bucket, procedure executed verbatim): zero errors, zero data loss (every original row, plus a new write made mid-procedure into the newly-bounded range, present and correctly partitioned afterward), FK enforcement and the blob-role/finalized triggers all still correctly active on the reattached partitions afterward.

2. **Blob-role integrity had no DELETE/UPDATE guard (both reviewers flagged this, one calls it a hard BLOCK).** The v3 triggers only fired on the *referencing* table's INSERT/UPDATE, checking role existence at that moment only. Nothing stopped: insert a `chain_blob_roles` row, insert a referencing row (passes the check), `DELETE FROM chain_blob_roles` — leaving the referencing row pointing at a now-unclassified blob with no error anywhere; the v3 migration's own comment explicitly (and, in hindsight, wrongly) said this gap didn't need closing. Also flagged: the existing role-existence check was an unlocked `EXISTS`, which can race a concurrent role deletion. **Fixed with a `BEFORE DELETE OR UPDATE OF blob_hash, role` trigger on `chain_blob_roles` itself** (`chain_archive_assert_role_removable` / `chain_blob_roles_guard_removal_trigger`, `001_chain_archive_core.ts`) that rejects removing/repointing a role still relied on by a live row in whatever table consumes that role. **The concurrency race was closed with real row-level locking, not assumed safe**: the insert-side check now takes `FOR SHARE` on the specific `(blob_hash, role)` row it depends on; the new delete-side guard takes `FOR UPDATE` on that same row before deciding. **Empirically tested with two genuinely concurrent Postgres sessions, both interleavings**: (a) an in-flight referencing INSERT holding its `FOR SHARE` lock forces a concurrent DELETE to block until the INSERT's transaction resolves, after which the DELETE correctly fails once it sees the now-committed reference; (b) an in-flight DELETE forces a concurrent referencing INSERT to block until the DELETE's transaction resolves, after which the INSERT correctly fails once it sees the role is gone. Both orderings converge on the same safe outcome — it is impossible to end up with a live reference to a removed role. See §4.1.

3. **`finalized` monotonicity was not actually enforced (new finding, valid).** The v3 `CHECK (NOT finalized OR is_canonical)` only enforces the relationship at a point in time — nothing stopped `UPDATE blocks SET finalized = false, is_canonical = false, status = 'orphaned'` on a row that was previously finalized, which cannot happen under real GRANDPA finality semantics (finalized blocks never become un-finalized). Fixed with a `BEFORE UPDATE OF finalized` trigger (`blocks_enforce_finalized_monotonic` / `blocks_finalized_monotonic_trigger`) rejecting exactly `OLD.finalized = true AND NEW.finalized = false`, propagated to every partition the same way the v3 blob-role triggers are (confirmed via `pg_trigger`). **Empirically verified**: the illegal un-finalization transition is rejected; an unrelated-column update on an already-finalized row still succeeds; a not-yet-finalized canonical block can still legally flip to non-canonical on a reorg; a not-yet-finalized block can still legally transition to finalized. See §4.2.

4. **Verifier-key uniqueness key was missing `tag`/entry-point identity (both reviewers converged on this).** The design doc's own text says the same VK bytes can legitimately appear under different entry points within one contract, and that `tag` is meant to distinguish this real case — but `tag` was not part of the v3 `UNIQUE NULLS NOT DISTINCT` key, so two distinct legitimate entry-point observations collided and one was silently lost. Fixed by adding `tag` to the key. Also fixed the related `first_seen_height` concern: as previously keyed, the same logical `(vk_hash, net, scope, contract_address)` context could be inserted repeatedly with different claimed `first_seen_height` values, producing multiple contradictory "first-seen" rows for what should be one identity. **Resolution: `first_seen_height` is removed from the uniqueness key entirely** — it's a mutable "earliest known" fact about an observation context, not part of that context's identity, and is now maintained via `INSERT ... ON CONFLICT (vk_hash, net, scope, contract_address, tag) DO UPDATE SET first_seen_height = LEAST(verifier_key_observations.first_seen_height, EXCLUDED.first_seen_height)`. Also dropped the now-redundant `verifier_key_observations_by_vk_hash` index — **confirmed, not assumed**, via `EXPLAIN (COSTS OFF)` against a real Postgres 17 instance that a `vk_hash`-only lookup already uses a Bitmap Index Scan on the corrected UNIQUE constraint's own backing index (leading column `vk_hash`), with no separate index needed. **Empirically verified**: two different-tag observations of the same `(vk_hash, net, scope, contract_address)` now both persist as distinct rows; the `ON CONFLICT`/`LEAST` upsert collapses repeated sightings of the same full context into one row holding the minimum `first_seen_height` across all of them; a plain (non-upsert) duplicate-context INSERT is still correctly rejected. See §4.5.

5. **`finalized` monotonicity prose updated to match #3.** §4.2's transition-semantics text previously described the invariant as snapshot-time-only ("not a temporal one") — now describes it accurately as DB-enforced monotonicity via the new trigger.

6. **Test coverage gap closed (both reviewers flagged, converging finding).** `test/postgres/chain-archive-migrate.test.ts` previously only exercised happy-path role creation (the helper always created the role before the reference) plus one FK-violation case on `transactions` only. Extended with real negative coverage: (a) a missing-role rejection on `blocks`, `bridge_observations`, and `verifier_key_observations` as well, not just `transactions`; (b) deleting a role out from under an active reference (rejected, closing #2); (c) un-finalizing a previously-finalized block (rejected, closing #3); (d) two legitimate different-tag VK observations of the same key persisting, plus a true duplicate context being rejected (closing #4).

---

### v3 — 2026-07-22, revised in response to a round-2 3-reviewer design-council re-audit (Fable 5 / Opus / GPT-5.6 Sol)

All three reviewers re-read the v2 revision (`5eb860e`) in full. Two called it stable with minor nits; GPT-5.6 Sol raised real findings. Cross-referencing all three, several of the "minor" items turned out to be 2-of-3 convergent, plus one reviewer surfaced a genuine new gap. All six are fixed below with real schema/migration/doc changes, not caveats.

1. **`finalized` consistency (2 of 3 reviewers).** The v2 `CHECK ((status='canonical') = is_canonical)` only tied two of the three fields together — `blocks(finalized=true, status='seen', is_canonical=false)` was legal, which cannot happen under real Substrate/GRANDPA finality semantics (a finalized block is always canonical). Added `CHECK (NOT finalized OR is_canonical)` (`001_chain_archive_core.ts`). §4.2 below now states the invariant explicitly: **finalized ⇒ canonical ⇒ status='canonical'**. Empirically verified against a real Postgres 17 instance: the new CHECK rejects the illegal combination and accepts every legal one.
2. **Blob-role integrity loss (2 of 3 reviewers).** `chain_blob_roles` could legally have zero rows for a `chain_blobs` hash that `blocks`/`transactions`/`bridge_observations`/verifier-key rows referenced directly — a real regression from the pre-v2 `kind NOT NULL` column, which guaranteed every blob was classified. Chose enforcement over documentation-only: a shared `chain_archive_assert_blob_role()` plpgsql helper plus one thin `BEFORE INSERT OR UPDATE` trigger per blob-referencing table/column (`blocks` ×2, `transactions`, `bridge_observations`, `verifier_key_observations`). **Empirically verified** against a real Postgres 17 instance that a row-level `BEFORE INSERT` trigger on a `PARTITION BY RANGE` parent table is automatically cloned onto every existing and future partition (PG11+ behavior, confirmed via `pg_trigger`), and that the trigger correctly rejects a reference to an unclassified blob while accepting a classified one. See §4.1.
3. **Rollover runbook broken by this feature's own FKs (2 of 3 reviewers, and worse than originally reported).** The v2 runbook only described creating a new partition for `blocks`; `transactions` and `bridge_observations` need new partitions at the same height boundary too (the migration itself already pre-creates all three in lockstep — `createHeightPartitions` was already called for all three tables — so this was purely a runbook-prose gap, not a schema gap). Worse: the v2 runbook's DEFAULT-drain fallback (copy overflow rows out, delete from `blocks_default`) is now provably broken by the FKs `transactions`/`bridge_observations` added in v2 — **reproduced directly**: `DELETE FROM blocks_default` while a live `transactions` row still references a row inside it fails with `foreign key constraint ... violates`, with no valid ordering that avoids it while the partition stays attached. §4.6 is rewritten around a DETACH/re-ATTACH procedure across all three tables in dependency order, verified end-to-end against real Postgres 17 (see §4.6 for the full transcript).
4. **Verifier-key modeling gaps (new finding, one reviewer, confirmed independently).** Two issues, both fixed: (a) the CHECK only enforced `scope='contract' => contract_address IS NOT NULL`, not the full "iff" the doc's own comment claimed — fixed to `CHECK ((scope = 'contract') = (contract_address IS NOT NULL))`, empirically confirmed to reject both illegal directions. (b) `PRIMARY KEY (vk_hash)` alone was too narrow. **Verified directly against `transient-crypto/src/proofs.rs` and `ledger/src/structure.rs`** (not assumed): `VerifierKey`'s content-addressed bytes are a pure function of the compiled circuit with no network/contract/address salt, and `structure.rs`'s `VerifierKeyInsert(EntryPointBuf, ContractOperationVersionedVerifierKey)` attaches a VK to a contract's own per-entry-point map — so the same VK bytes genuinely can and do recur across multiple networks (same protocol version) and multiple contract addresses (same circuit/template deployed more than once). `verifier_keys` is replaced by `verifier_key_observations`, a junction table recording each `(vk_hash, net, scope, contract_address, first_seen_height)` context a key was actually seen in; the content-addressed half needed no new table (`chain_blobs` + `chain_blob_roles(role='verifier_key')`, already introduced by fix 2, already are that). See §4.5.
5. **Completeness-claim overclaim (new finding, one reviewer, valid documentation fix).** §9 claimed a parent-hash walk proves the archive is "complete." Rewritten to state precisely what that check proves (canonical-header continuity for the one chain walked) versus what it does NOT prove (fork completeness, transaction/observation completeness, or body integrity — `extrinsics_root` cannot be recomputed and checked since block bodies are nullable). See §9.
6. **Minor items:** `transactions.protocol_version` gained `CHECK (protocol_version >= 0)` (the v2 doc's "nonnegative checks throughout" claim didn't actually cover it); the `transactions_by_block` index was dropped as a strict left-prefix of the existing PK index (`transactions_by_hash` is kept — it is not a PK left-prefix); one automated test (`test/postgres/chain-archive-migrate.test.ts`) now exercises `runMigrations(sql, { schema, migrations: chainArchiveMigrations })` end-to-end — fresh apply, idempotent re-run, a same-height fork with an overlapping tx hash, a rejected dual-canonical insert, and a rejected FK violation — closing the "no committed automated test for the new lineage" gap; confirmed `origin/main` only moved with an unrelated docs commit (`b1ecc53`) since this branch was cut, nothing to reconcile.

### v2 — 2026-07-22, revised in response to a 3-reviewer design-council audit (Fable 5 / Opus / GPT-5.6 Sol)

All three reviewers independently read the original draft (`cb80f96`) in full and converged strongly on several defects; this revision fixes all of them with real schema/migration changes, not caveat comments. Summary of what changed:

1. **Fork-breaking `transactions` PK bug fixed** (caught independently by 2 of 3 reviewers) — PK changed from `(block_height, tx_hash)` to `(net, block_height, block_hash, tx_hash)`, plus a separate `UNIQUE (net, block_height, block_hash, position)` constraint. See §4.3.
2. **Canonical-chain uniqueness is now enforced**, not just conventionally assumed — a `CHECK` ties `status`/`is_canonical` together, and a partial unique index enforces at most one canonical block per `(net, height)`. This was **empirically verified against a real Postgres 17 instance** (transcript in §4.2) rather than resolved by trusting either reviewer's unverified claim about partitioned-table behavior.
3. **Bridge/governance data reclassified from "defer" to "build now."** The original deferral's stated justification (replay-recoverable from raw transaction bytes) is contradicted by the design's own observation that bridge data lives in Substrate inherents (block body), not `transactions`, and `body_blob_hash` was nullable pending unscheduled body-sync work. A new lean `bridge_observations` table (§4.4) closes this gap without waiting on body sync. Zswap/unshielded/dust remain deferred, but now carry an explicit **UNVERIFIED** flag (§7) instead of an asserted-but-untested "replay-recoverable" claim.
4. **`block_undo` cut entirely** (unanimous across all three reviewers) — zero function in an insert-only v1, unspecified payload, reserving the shape bought nothing a future migration couldn't provide just as well when a real need exists.
5. **Moved to its own schema and migration lineage — "Tier-1.5."** No longer `005_chain_archive.ts` inside the `tier1_wallet`-numbered sequence; now `src/postgres/migrations/chain_archive/{000_schema (reused), 001_chain_archive_core}.ts`, applied to its own `chain_archive` schema via a new `chainArchiveMigrations` lineage array. `migrate.ts` gained one small, generic addition (`RunMigrationsOptions.migrations`) to support a second lineage; still not wired into any executing path. Resolves the previously-open Tier-1/Tier-2 architectural tension from the original draft's §9 — this is neither Tier-1 nor the Tier-2 indexer fork.
6. **Other convergent fixes**: real FK from `transactions`/`bridge_observations` to `blocks` (empirically confirmed working across two range-partitioned tables); `chain_blobs.kind` replaced with a `chain_blob_roles` many-to-many table (one hash, many roles, no contradiction); `size_bytes` is now a generated column; `verifier_keys` gained a real `scope='contract' => contract_address IS NOT NULL` CHECK and a `contract_address` index; the partition-size constant is now a single real source of truth (`partition-config.ts`) instead of a hardcoded literal contradicting the doc's "configurable" claim; a concrete partition pre-creation + rollover runbook replaces the bare "use `pg_partman` later"; nonnegative/fixed-length sanity CHECKs added throughout; a `net` column added everywhere chain identity/genesis binding was previously unenforced, matching `002_checkpoint_store.ts`'s existing `net` convention.

What was **kept unchanged** because all three reviewers praised it: the `chain_blobs`-as-sibling-to-`ckpt_chunks` decision (§4.1), the block-tree-not-just-canonical-chain modeling in `blocks` (§4.2), and the overall metadata/blob-reference split pattern.

---

## 1. Problem and core principle

UmbraDB's `tier1_wallet`-shaped schema (`_migrations`, `kv_current`/`kv_history`, `ckpt_*`, `watermarks`, `transaction_history`) persists **wallet-scoped** state. Nothing in it today survives an indexer wipe, a `midnight-indexer` schema migration, or a version bump that changes `midnight-indexer`'s own table shapes — because nothing in it is chain-scoped. `midnight-indexer` (confirmed live against `midnight-indexer:4.0.2` this session, §3) already holds a rich relational archive, but it is a dependency UmbraDB's own architecture forbids at runtime (`test/postgres/no-sdk-import-guard.test.ts`; `design/design.md`'s Tier-1/Tier-2 split) and its own deep Merkle-DAG arena state is pruned to a sliding window, not archived.

**The principle this design follows (from Erigon/geth-freezer/Bitcoin Core, cross-cut against the real Midnight data model):** split **raw, cheap, replay-capable payload** (block bytes, tx bytes, proof/VK blobs — content-addressed, append-only, never re-derived by parsing) from **lean, queryable metadata** (heights, hashes, parent links, canonical-chain status — exactly what a recovery or reconciliation workflow filters or joins on). Do **not** duplicate data the indexer already relationally archives well UNLESS UmbraDB's independent survival of an indexer wipe requires it, and do not archive data that is cheaply re-derivable from the raw payload once it exists (Erigon's E3 receipts precedent) — **but that re-derivability has to actually be checked, not assumed** (§7's UNVERIFIED flag exists precisely because the original draft asserted it without testing it, and got it wrong for one whole category — bridge data — that this revision reclassifies).

This schema is **Tier-1.5**: chain-scoped, but neither `tier1_wallet` (wallet/checkpoint persistence, `design/design.md` §0) nor the already-planned Tier-2 (a deliberate fork of the official indexer's own Postgres schema). It gets its own Postgres schema (`chain_archive`) and its own migration lineage, entirely separate from both. This resolves the architectural tension the original draft's §9 flagged as unresolved rather than picking a side.

---

## 2. Source grounding

- **Industry prior art**: Cardano db-sync (raw/queryable split, dictionary normalization, canonical-only + cascade rollback — flagged as a real limitation, not copied), Erigon (current+history/changeset split, don't archive the cheaply-recomputable), geth freezer / Bitcoin Core (append-only blob store separate from a rebuildable typed index; full block tree, not cascade-delete), Solana (no early archival plan ⇒ costly multi-year retrofit — the cautionary case for building this now).
- **Midnight source, cited directly, re-verified live this session where noted:**
  - Header shape: `midnight-node/runtime/src/lib.rs:1157`, standard Substrate `generic::Header<BlockNumber,BlakeTwo256>` — **confirmed live**, §3.1.
  - Opaque SCALE-wrapped ledger tx: `pallets/midnight/src/lib.rs`'s `send_mn_transaction(origin, midnight_tx: Vec<u8>)` — **confirmed live**, §3.2 (the raw bytes literally begin with the ASCII tag `midnight:system-transaction[v6]:`).
  - Zswap: `midnight-ledger/zswap/src/structure.rs` + `ledger.rs` (`CoinCiphertext`, `Input`, `Output`, `Offer`, `State{coin_coms, nullifiers, past_roots}`).
  - Unshielded: `midnight-ledger/ledger/src/structure.rs:2857+` (`Utxo{value,owner,type_,intent_hash,output_no}`) — **confirmed live**, §3.4.
  - Dust: `midnight-ledger/ledger/src/dust.rs` (`DustOutput`, `DustGenerationInfo`, `DustSpend`, `DustRegistration`) — **confirmed live**, §3.5.
  - Contract: `midnight-ledger/onchain-state/src/state.rs` + `ledger/src/structure.rs:2400+` (`ContractState`, `ContractCall`, `ContractDeploy`) — schema confirmed via introspection only, **zero live instances on this devnet** (§3.6).
  - Events: `midnight-ledger/ledger/src/events.rs` (`Event{source, content: EventDetails}`) — **confirmed live**, §3.5/§3.7 (`ParamChange`, `DustInitialUtxo`, `DustGenerationDtimeUpdate`, `ZswapOutput` all observed).
  - Verifier keys: `transient-crypto/src/proofs.rs:377`, tag `verifier-key[v6]`.
  - Bridge/D-parameter/SPO: `midnight-node/primitives/system-parameters/src/lib.rs`; indexer's `cnight_registrations`, `system_parameters_d`, `spo_*` — **cnight_registrations and system_parameters_d confirmed live**, §3.8; `spo_*` schema-only (0 rows on this devnet). Substrate inherents (which is where these observations actually get carried on-chain) live in the block **body**, not `transactions` — see §4.4 for why this revision no longer treats "defer, replay-recoverable" as a safe call for this category.
- **UmbraDB's live schema** (`src/postgres/migrations/000_schema.ts`–`004_transaction_history.ts`, re-read this session): the `sql(schema)`-parameterized, no-ORM, raw-`postgres.js`-tagged-SQL migration convention this document's own migration (§8) follows; `ckpt_chunks` (`002_checkpoint_store.ts`) is the existing SHA-256-content-addressed blob table this design evaluates extending (§4.1 explains why it does not); `checkpoint-store.ts`'s `net` column is the existing network-identity convention this revision's `net` columns match (§4.2–§4.5).
- **`design/design.md` §0**: UmbraDB's Tier-1/Tier-2 split — Tier 1 is `tier1_wallet`-schema checkpoint/temporal-KV/tx-history (migrations 000–006); Tier 2 is a *separate, already-planned* tier that forks the official indexer's own Postgres schema plus TimescaleDB. This revision resolves the tension the original draft left open: this schema is **neither** — it is Tier-1.5, its own schema/lineage (§5, §8).
- **`feature/verifiable-snapshot` design** (`design/verifiable-snapshot-design.md`, read via `git show origin/feature/verifiable-snapshot:...`): the L0–L3 layering this document generalizes in §9.

---

## 3. Live-node/indexer confirmation

Devnet confirmed reachable this session: node RPC `localhost:9944` (`midnightntwrk/midnight-node:0.22.5`, chain `undeployed1`, tip height 17063 at query time), indexer GraphQL `localhost:8088/api/v3/graphql` (`midnightntwrk/indexer-standalone:4.0.2`, SQLite-backed at `/data/indexer.sqlite` inside the `midnight-indexer` container — read directly via `docker cp` + Python's stdlib `sqlite3` for real row/schema evidence beyond what GraphQL exposes). All output below is real, pasted verbatim (hex/bytes truncated only where noted).

### 3.1 Block header

Every recent block (17050–17063) sampled was empty of transactions — this devnet is idle apart from block production — so the header check used `chain_getHeader` (no params ⇒ current head) directly against the node RPC:

```
$ curl -s -X POST http://localhost:9944 -d '{"id":1,"jsonrpc":"2.0","method":"chain_getHeader","params":[]}'
{"jsonrpc":"2.0","id":1,"result":{
  "parentHash":"0x70cf12694c7ff05890e6a3858f828c3b0f08846330c054bc4b883b34fd835d2c",
  "number":"0x42ab",
  "stateRoot":"0xde3a7502421cc4875189819c67061d5867ff517f01d28a054e551efdad84985c",
  "extrinsicsRoot":"0x60feb098d00f465cd81d1a986e96d3e66894ac6d0b9a26ca32abb0846deadb67",
  "digest":{"logs":["0x066175726120a0cfba1100...","0x066d637368800551a4b0...","0x044d4e5356...","0x04424545...","0x056175726101017cd795..."]}
}}
```
Exactly the five fields `midnight-node/runtime/src/lib.rs:1157`'s standard Substrate header predicts: `parent_hash`, `number`, `state_root`, `extrinsics_root`, `digest.logs[]` — confirms the `blocks` table's queryable-column set (§4.2) with no surprises.

### 3.2 Raw transaction blob (opaque SCALE-wrapped ledger tx)

Indexer's `transactions.raw` column, queried via GraphQL against genesis (height 0, the one block on this devnet with real transactions — see §3.3):

```
$ curl -s -X POST http://localhost:8088/api/v3/graphql -d '{"query":"{ block(offset:{height:0}) { transactions { hash protocolVersion raw } } }"}'
{"data":{"block":{"transactions":[
  {"hash":"c17745ff792c0645d8ce1b3a2e12db032c8c59c94f85efad1f0422943eb2114b","protocolVersion":22000,
   "raw":"6d69646e696768743a73797374656d2d7472616e73616374696f6e5b76365d3a050f0080c6a47e8d03"},
  ...
]}}}
```
`raw` hex-decodes to ASCII `midnight:system-transaction[v6]:` + payload — this is `send_mn_transaction`'s opaque `Vec<u8>` (`pallets/midnight/src/lib.rs`), confirming the "raw transaction store is naturally a blob-store concern" claim: the wire format is itself domain-separated and self-tagged, exactly like `VerifierKey`'s `verifier-key[v6]` tag (`transient-crypto/src/proofs.rs:377`).

### 3.3 Transactions / regular_transactions (queryable metadata split)

Direct SQLite inspection of the indexer's own storage (`docker cp midnight-indexer:/data/indexer.sqlite`, `python3 -c 'import sqlite3; ...'`) — row counts across the whole synced chain:

```
blocks 17100   transactions 26   regular_transactions 21   contract_actions 0
unshielded_utxos 20   ledger_events 128   dust_generation_info 85
contract_balances 0   cnight_registrations 3496   spo_identity 0   system_parameters_d 1
```
All 26 transactions are in `block_id=1` (the indexer's internal surrogate id for **height 0**, confirmed via `select id, height, hex(hash) from blocks where id=1` → `(1, 0, '1AA4A32F...')`) — this devnet's only real activity is its genesis-time bootstrap allocation. `transactions` schema (`PRAGMA table_info`):
```
id, block_id, variant('System'|'Regular'), hash, protocol_version, raw
```
`regular_transactions` schema: `id, transaction_result('"Success"'), merkle_tree_root, start_index, end_index, paid_fees, estimated_fees` — confirms the CardanoDB-sync-style split (raw payload in one column, queryable result/root/index fields in sibling columns) UmbraDB's own `transactions` table (§4.3) follows.

### 3.4 Unshielded UTXOs

```
$ curl ... -d '{"query":"{ block(offset:{height:0}) { transactions { hash unshieldedCreatedOutputs { owner tokenType value outputIndex intentHash } } } }"}'
{"data":{"block":{"transactions":[...,
  {"hash":"ca0ba819...","unshieldedCreatedOutputs":[{
     "owner":"mn_addr_undeployed1h3ssm5ru2t6eqy4g3she78zlxn96e36ms6pq996aduvmateh9p9sk96u7s",
     "tokenType":"0000000000000000000000000000000000000000000000000000000000000000",
     "value":"50000000000000","outputIndex":0,
     "intentHash":"9088914a55294e336fc812e224c8f49fd9e85a77a949f0cd5d803fcf3617f58a"}],
   ...}]}}}
```
Field-for-field match to `Utxo{value,owner,type_,intent_hash,output_no}` (`ledger/src/structure.rs:2857+`). SQLite `unshielded_utxos` schema adds the lifecycle columns the GraphQL view doesn't surface directly: `creating_transaction_id, spending_transaction_id (nullable), ctime, initial_nonce, registered_for_dust_generation` — confirms the full create→spend lifecycle claim from the research brief.

### 3.5 Dust generation + ledger events (generic)

```
$ curl ... -d '{"query":"{ block(offset:{height:0}) { transactions { hash dustLedgerEvents { __typename } } } }"}'
```
returned, across the 26 genesis transactions: 22× `DustInitialUtxo`, 13× `DustGenerationDtimeUpdate`, 2× `ParamChange`, real `mn_addr_undeployed1...` owners and 32-byte hex hashes throughout. SQLite `ledger_events` variant/grouping distribution over the whole chain:
```
DustGenerationDtimeUpdate | Dust  | 13
DustInitialUtxo           | Dust  | 85
ParamChange                | Dust  | 2
ZswapOutput                | Zswap | 28
```
This is a direct, live match to the `Event`/`EventDetails` variant list in `ledger/src/events.rs` — and it is genesis-only data (no post-genesis dust/zswap activity on this idle devnet). `DustLedgerEvent` GraphQL introspection returned exactly `ParamChange, DustInitialUtxo, DustGenerationDtimeUpdate, DustSpendProcessed`.

### 3.6 Contract state/actions — confirmed absent, not confirmed present

`__type(name:"ContractAction"){possibleTypes{name}}` → `ContractDeploy, ContractCall, ContractUpdate` (schema exists). SQLite: `contract_actions 0`, `contract_balances 0` rows. **Honest limitation:** this devnet has never had a contract deployed, so the contract-state shape is confirmed only at the GraphQL-schema level, not against a real instance (§7).

### 3.7 Governance / bridge

```
system_parameters_d: (id=1, block_height=0, block_hash=<32B>, timestamp=1754395200000,
                       num_permissioned_candidates=10, num_registered_candidates=0)
cnight_registrations: 3496 rows, e.g. (cardano_stake_key=<32B>, dust_address=<32B>, valid=1,
                       registered_at=1754395200000, block_id=1, utxo_tx_hash=<32B>, utxo_output_index=0)
```
Both real, live, non-trivial data. **Revised call (§4.4/§7):** the original draft deferred this category on the assumption it is replay-recoverable from raw transaction bytes; this revision reclassifies it to build-now, because these observations are carried in Substrate inherents (block body), not `transactions.raw` — see §4.4 for the full reasoning and the `bridge_observations` table this adds.

### 3.8 SPO/staking

`spo_identity`, `spo_epoch_performance`, `spo_history` etc. all present in the schema but **zero rows** — this devnet has no registered stake pool operators. Schema-confirmed only. This category remains **not needed in UmbraDB** (§7): lowest priority, Cardano-side registration data, indexer's coverage is comprehensive, and there is no live evidence yet to validate a UmbraDB copy against.

---

## 4. Schema design

All tables below live in the `chain_archive` schema (§5) via `src/postgres/migrations/chain_archive/001_chain_archive_core.ts`.

### 4.1 `chain_blobs` / `chain_blob_roles` — content-addressed blob store (unchanged decision: new sibling table, NOT an in-place extension of `ckpt_chunks`)

**Decision kept from the original draft, praised by all three reviewers: new table, not `ckpt_chunks` + a `kind` column.** Justification unchanged: `ckpt_chunks` is load-bearing for `CheckpointStore`'s specific lifecycle — its rows are reclaimed by a `NOT EXISTS`-against-`ckpt_manifest_chunks` GC query whose correctness depends on *every* row in `ckpt_chunks` being reachable only through that one junction table. Chain-archive blobs (block/tx/proof/VK/bridge-observation bytes) have a **different, incompatible lifecycle**: referenced by permanent, range-partitioned rows, never pruned by a manifest-completion event. A sibling table with the same proven shape (SHA-256 PK, `bytea` payload) avoids entangling two independently-evolving modules' GC correctness through a shared table.

```sql
CREATE TABLE chain_blobs (
  hash       bytea PRIMARY KEY CHECK (octet_length(hash) = 32),
  data       bytea NOT NULL,
  size_bytes integer GENERATED ALWAYS AS (octet_length(data)) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

**Two revisions from the original draft, both audit findings:**
- `size_bytes` is now `GENERATED ALWAYS AS (octet_length(data)) STORED` instead of a caller-supplied integer that could silently disagree with `data`'s real length. **Empirically confirmed** against a real Postgres 17 instance while revising this migration: inserting a 5-byte payload produces `size_bytes = 5` with no application code computing it, and a short (non-32-byte) `hash` value is correctly rejected by the new CHECK.
- `hash` now has an explicit `CHECK (octet_length(hash) = 32)` (SHA-256 is always 32 bytes) instead of trusting arbitrary content unconditionally.

**`kind` is REMOVED from `chain_blobs` itself** and replaced with a many-to-many role table — the audit's resolution to the reviewer-flagged contradiction: the original draft's own §4.1 argued identical content can correctly serve multiple logical roles ("a block header and a tx body are never going to coincide, and if they did, deduplicating them is still correct, not a bug") while simultaneously storing a single required `kind` enum value per row. A blob whose bytes are later legitimately reused under a second role would either violate the row's fixed classification or silently misreport it. This revision picks the many-to-many resolution (rather than "accept and document one-hash-one-kind as intentional") because the design's own stated principle already assumes multi-role reuse is a real, correct case, not a hypothetical edge case to be defined away:

```sql
CREATE TABLE chain_blob_roles (
  blob_hash bytea NOT NULL REFERENCES chain_blobs(hash),
  role      text  NOT NULL CHECK (role IN ('block_header', 'block_body', 'tx_raw', 'proof', 'verifier_key', 'bridge_observation')),
  PRIMARY KEY (blob_hash, role)
);
CREATE INDEX chain_blob_roles_by_role ON chain_blob_roles (role);
```
`chain_blob_roles_by_role` replaces the old `chain_blobs_kind` index's filter/diagnostic use case without the contradiction. No range partitioning in v1 for either table (unchanged from the original draft): hash is uniform-random, so there is no natural range key, and blob volume at devnet/early-mainnet scale doesn't yet justify list-partitioning by role. Flagged as a v2 candidate once `tx_raw` volume dominates (§10).

This table is a deliberately good target for the sibling `feature/network-torrent` branch's retrieval work (SHA-256-keyed, content-addressed) — no design coordination needed beyond that shape being stable.

**v3 audit fix — blob-role integrity, flagged by 2 of 3 round-2 reviewers.** Nothing above stopped a `chain_blobs` row from having zero `chain_blob_roles` rows, even though `blocks.header_blob_hash`/`body_blob_hash`, `transactions.raw_blob_hash`, `bridge_observations.raw_blob_hash`, and (post-v3) `verifier_key_observations.vk_hash` all reference `chain_blobs(hash)` directly with no guarantee a role row exists for the hash they point at — a real regression from the pre-v2 `kind NOT NULL` column, which guaranteed every blob was classified. The audit offered a choice: (a) enforce it (trigger/constraint), or (b) document role-tagging as advisory-only (the real reference is each FK column; roles are just a queryable label) if enforcement isn't worth the complexity. **Chose (a).** It turned out not to be excessively complex: one shared plpgsql helper plus one thin `BEFORE INSERT OR UPDATE` trigger per consuming table/column.

```sql
CREATE FUNCTION chain_archive_assert_blob_role(
  p_blob_hash bytea, p_role text, p_table text, p_column text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_blob_hash IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM chain_blob_roles WHERE blob_hash = p_blob_hash AND role = p_role) THEN
    RAISE EXCEPTION 'blob % referenced by %.% has no chain_blob_roles row for role %',
      encode(p_blob_hash, 'hex'), p_table, p_column, p_role USING ERRCODE = '23514';
  END IF;
END;
$$;

-- one thin trigger per consuming table, e.g.:
CREATE FUNCTION transactions_check_blob_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM chain_archive_assert_blob_role(NEW.raw_blob_hash, 'tx_raw', 'transactions', 'raw_blob_hash');
  RETURN NEW;
END;
$$;
CREATE TRIGGER transactions_blob_roles_trigger
  BEFORE INSERT OR UPDATE OF raw_blob_hash ON transactions
  FOR EACH ROW EXECUTE FUNCTION transactions_check_blob_roles();
```

**Empirically verified against a real Postgres 17 instance while revising this migration:** (1) a row-level `BEFORE INSERT` trigger defined on a `PARTITION BY RANGE` *parent* table is automatically cloned onto every existing and future partition — confirmed via `pg_trigger` listing the trigger present on the parent and every child partition after creating the parent-level trigger (PG11+ behavior; nothing has to be redeclared per-partition). (2) The trigger correctly rejects an insert whose referenced blob has no matching `chain_blob_roles` row (`RAISE EXCEPTION` fires with the expected message) and correctly accepts one that does, once the role row is inserted first.

`blocks.body_blob_hash` is nullable, so its trigger check (like the helper function itself) no-ops on `NULL` and only fires once a body blob is actually attached.

**v4 audit fix — the delete/update-side half of this same gap (both round-3 reviewers, one calls it a hard BLOCK).** The paragraph above, in v3, claimed this was safely insert/update-time-only because "nothing here ever deletes a `chain_blob_roles` row." That claim was wrong in the sense that mattered: nothing in the *schema* prevented it — `DELETE FROM chain_blob_roles` was always valid SQL against this table, regardless of whether anything in the application's insert-only *convention* was expected to issue it. Concretely: insert a `chain_blob_roles` row, insert a referencing row (passes the trigger check above), then `DELETE FROM chain_blob_roles` — the referencing row is left pointing at a now-unclassified blob, with no error anywhere. Fixed with a `BEFORE DELETE OR UPDATE OF blob_hash, role` trigger directly on `chain_blob_roles` (`chain_archive_assert_role_removable` / `chain_blob_roles_guard_removal_trigger`, `001_chain_archive_core.ts`) that rejects removing or repointing a role row still relied on by a live row in whichever table consumes that role (`blocks` ×2, `transactions`, `bridge_observations`, `verifier_key_observations`; `role='proof'`, which nothing currently consumes, is never blocked).

**The concurrency angle was thought through explicitly and closed with real row-level locking, then tested with two genuinely concurrent Postgres sessions, not reasoned about in the abstract.** An unlocked `EXISTS` check on either side of this relationship (the original insert-side check, or a naively-written delete-side guard) still races: the insert-side check might see the role exists, then a concurrent delete removes it before the insert commits, or vice versa. Closed by taking a lock on the *same* `chain_blob_roles` row from both directions:
- The insert-side check (`chain_archive_assert_blob_role`) now ends its `EXISTS` subquery with `FOR SHARE`, held for the remainder of that INSERT/UPDATE's transaction.
- The new delete-side guard (`chain_archive_assert_role_removable`) takes `FOR UPDATE` on that same row before deciding whether removal is safe.

Postgres's real row-level lock semantics make both interleavings safe, and both were verified directly with two real concurrent `psql` sessions against a real Postgres 17 instance (not simulated, not merely reasoned about):
- **Referencing INSERT holds the lock first.** Session A opens a transaction, inserts a row referencing the blob/role (acquiring `FOR SHARE` on the `chain_blob_roles` row), and pauses before committing. Session B's concurrent `DELETE FROM chain_blob_roles WHERE blob_hash = ... AND role = ...` blocks — measured wall-clock: the DELETE waited ~4.5s, exactly matching session A's induced delay, and only proceeded once session A committed. Once unblocked, the DELETE's guard re-evaluates against the now-committed state, finds the live reference, and correctly raises `ERROR: cannot remove/change chain_blob_roles row ...: still referenced by a live row`.
- **DELETE holds the lock first.** Session A opens a transaction, deletes the (as yet unreferenced) role row, and pauses before committing. Session B's concurrent `INSERT INTO transactions (...) VALUES (...)` referencing that same blob/role blocks — measured wall-clock: ~4.6s, matching session A's delay — and only proceeds once session A commits. Once unblocked, the INSERT's own `FOR SHARE` re-check finds the role genuinely gone and correctly raises `ERROR: blob ... has no chain_blob_roles row for role ...`.

Both orderings converge on the same safe outcome: it is not possible to end up with a live row referencing a `chain_blob_roles` entry that has actually been removed, regardless of which of the two concurrent transactions reaches the database first.

### 4.2 `blocks` — the block tree, not just the canonical chain

**Kept unchanged from the original draft, praised by all three reviewers:** every received block is kept, canonical or not — the Bitcoin Core pattern, chosen specifically because indiscriminate cascade-delete-on-reorg (Cardano db-sync's pattern) is a real limitation for a store whose entire purpose is being a recovery source of last resort.

```sql
CREATE TABLE blocks (
  net              text        NOT NULL,
  block_hash       bytea       NOT NULL CHECK (octet_length(block_hash) = 32),
  height           bigint      NOT NULL CHECK (height >= 0),
  parent_hash      bytea       NOT NULL CHECK (octet_length(parent_hash) = 32),
  state_root       bytea       NOT NULL CHECK (octet_length(state_root) = 32),
  extrinsics_root  bytea       NOT NULL CHECK (octet_length(extrinsics_root) = 32),
  author           bytea,
  header_blob_hash bytea       NOT NULL REFERENCES chain_blobs(hash),
  body_blob_hash   bytea       REFERENCES chain_blobs(hash),
  is_canonical     boolean     NOT NULL DEFAULT false,
  status           text        NOT NULL DEFAULT 'seen' CHECK (status IN ('seen', 'canonical', 'orphaned', 'pruned')),
  finalized        boolean     NOT NULL DEFAULT false,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'canonical') = is_canonical),
  CHECK (NOT finalized OR is_canonical),
  PRIMARY KEY (net, height, block_hash)
) PARTITION BY RANGE (height);

CREATE UNIQUE INDEX blocks_one_canonical_per_height ON blocks (net, height) WHERE is_canonical;
CREATE INDEX blocks_by_hash   ON blocks (block_hash);
CREATE INDEX blocks_by_parent ON blocks (parent_hash);
```

**What changed from the original draft, all audit findings:**

1. **Canonical-uniqueness enforcement (audit item 2) — previously unenforced entirely.** The original schema let multiple rows be marked canonical at the same height, and let `is_canonical`/`status`/`finalized` silently contradict each other. Fixed two ways:
   - `CHECK ((status = 'canonical') = is_canonical)` — the two flags can no longer diverge.
   - `blocks_one_canonical_per_height`, a **partial unique index** on `(net, height) WHERE is_canonical`.

   **This needed empirical verification, not a guess, because the three reviewers disagreed:** one claimed Postgres partial unique indexes don't work on partitioned tables at all; another implied `CREATE UNIQUE INDEX ... ON blocks (height) WHERE is_canonical` is legal specifically because `height` is the partition key. Neither was trusted blindly. **A real local Postgres 17 instance (`postgres:17-alpine` in Docker) was spun up specifically to test this.** Full empirical results:
   - `CREATE UNIQUE INDEX blocks_one_canonical_per_height ON blocks (net, height) WHERE is_canonical` — **succeeds**, on a table `PARTITION BY RANGE (height)`, and Postgres creates it as one native "partitioned index" with a matching, individually-valid child index automatically attached to every existing partition (`blocks_p0`, `blocks_p1`, `blocks_default` in the test) — confirmed via `\d+ blocks`, `pg_indexes`, and `pg_index.indisvalid = true` on every child.
   - **It genuinely enforces uniqueness, including the scenario that matters:** inserting a second canonical block at the same `(net, height)` correctly fails with `duplicate key value violates unique constraint`.
   - **Negative control:** `CREATE UNIQUE INDEX ... ON blocks (net) WHERE is_canonical` (omitting the partition key `height`) is **unconditionally rejected** by Postgres with `unique constraint on partitioned table must include all partitioning columns` — confirming this is a real, enforced Postgres rule, not something that silently misbehaves.
   - **Why this is correct, not a coincidence:** because `height` is the partition key, two rows sharing the same `height` value can only ever physically land in the same partition — range partitions don't overlap. So a per-partition-local unique index, which is all Postgres can build here, *is* a genuinely global constraint for any key that includes the partition key. This refutes the reviewer who claimed partial unique indexes "don't work" on partitioned tables (they do, and enforce correctly, for keys that include the partition key) and confirms the reviewer who attributed it to "height maps 1:1 to a partition" — that reviewer had the right mechanism, not a lucky guess.
   - This was re-verified end-to-end against the actual `001_chain_archive_core.ts` migration (not just the isolated test schema above): applying the real migration and attempting a second canonical insert at height 100 for the same `net` fails exactly as expected; a `status`/`is_canonical` divergence at a fresh height is independently rejected by the `CHECK`.

2. **Sanity CHECKs added:** `height >= 0`; `octet_length(...) = 32` on `block_hash`/`parent_hash`/`state_root`/`extrinsics_root` (fixed-length SHA-256/Blake2 hash sanity).

3. **`net`** (network/genesis-identity dimension) added, folded into the PK alongside `height`/`block_hash`. Nothing before this stopped two different networks' archive data from being silently comingled in one physical archive; naming matches the existing `net` column convention in `002_checkpoint_store.ts`/`checkpoint-store.ts`. **Scope note:** v1 still partitions by `height` alone (not `(net, height)` list-then-range sub-partitioning) — correct and sufficient for the expected deployment shape of one UmbraDB instance archiving one network's chain tree at a time, with `net` providing a hard safety rail against accidental comingling rather than a physical partitioning dimension. If a future deployment genuinely needs one physical archive schema serving multiple networks' data concurrently at volume, `PARTITION BY LIST (net)` with `height`-range sub-partitions per network is the natural next step — flagged, not built, since nothing in this pass's scope requires it (§10).

4. **v3 audit fix — `finalized` consistency (2 of 3 round-2 reviewers).** Point 1's `CHECK` only ties `status`/`is_canonical` together — it left `finalized=true, status='seen', is_canonical=false` legal, which cannot happen under real Substrate/GRANDPA finality semantics: GRANDPA only ever finalizes blocks on the chain it considers canonical, so a finalized block is always canonical. Added `CHECK (NOT finalized OR is_canonical)`. **Empirically verified against a real Postgres 17 instance:** the new CHECK rejects `(status='seen', is_canonical=false, finalized=true)` while accepting every legal combination — `(seen, false, false)`, `(canonical, true, true)`, `(canonical, true, false)` (canonical but not yet finalized — GRANDPA finality lags block production, so this is the normal steady state for the most recent several blocks).

   **Explicit transition semantics** (the design doc did not previously spell this out): a block row's lifecycle is `finalized ⇒ canonical ⇒ status='canonical'`, in that strict implication direction only — the converse does not hold. A block can be `is_canonical=true, finalized=false` (it is the current best chain's block at that height, per block-production/fork-choice, but GRANDPA has not yet finalized it — normal for recent blocks) and later either advance to `finalized=true` (once GRANDPA finalizes it — legal, since it was already canonical) or regress to `is_canonical=false` on a reorg (legal, since an unfinalized block can still be superseded). Once `finalized=true`, `is_canonical` may never become `false` for that row again.

   **v4 audit fix — this was previously a snapshot-time-only guarantee, not an actually-enforced monotonicity property (new finding, valid).** The v3 text above originally read: "the CHECK enforces this at every write, but note it is a snapshot-time constraint (true at the moment of each INSERT/UPDATE), not a temporal one" — which was an honest description of a real gap, but a gap nonetheless: `CHECK (NOT finalized OR is_canonical)` only ever inspects one row's values at the instant of a single write; nothing stopped `UPDATE blocks SET finalized = false, is_canonical = false, status = 'orphaned'` on a row that had `finalized = true` a moment before, which cannot happen under real GRANDPA finality semantics — GRANDPA finality is monotonic by construction; a finalized block never becomes un-finalized. Fixed with `blocks_enforce_finalized_monotonic` / `blocks_finalized_monotonic_trigger` (`001_chain_archive_core.ts`), a `BEFORE UPDATE OF finalized` trigger comparing `OLD`/`NEW` and rejecting exactly `OLD.finalized = true AND NEW.finalized = false`, propagated to every partition the same automatic way the blob-role triggers are (confirmed via `pg_trigger`). **This invariant is now genuinely DB-enforced monotonicity across writes, not merely a point-in-time relationship** — empirically confirmed against a real Postgres 17 instance: the illegal un-finalization transition is rejected with a clear error naming the offending block; an unrelated-column update on an already-finalized row (e.g. re-asserting `is_canonical = true`) still succeeds; a fresh, not-yet-finalized canonical block can still legally flip to non-canonical on a reorg (the guard only fires once `finalized` was actually `true`); and a fresh, not-yet-finalized block can still legally transition to `finalized = true`.

**Unchanged rationale from the original draft:** `parent_hash` still has no FK (a self-referencing FK across range partitions complicates out-of-order reorg backfill — a child block can arrive before its parent is durably committed; parent-link integrity remains an application-level invariant). `body_blob_hash` remains nullable pending body/extrinsics sync — see §4.4 for why this no longer blocks bridge-data archival. The canonical tip pointer is not a new table here — see §5's revised watermarks decision.

### 4.3 `transactions` — metadata only, raw bytes via blob reference

**THE FORK-BREAKING PK FIX (audit item 1 — caught independently by 2 of 3 reviewers, fixed first).** The original PK was `(block_height, tx_hash)`, omitting `block_hash` entirely. Since `blocks` correctly models the full block tree (competing/orphaned blocks at the same height, not just the canonical chain — PK `(height, block_hash)`), a completely normal fork scenario — two competing blocks at the same height both containing transaction T — collided on this PK, making it impossible to store both forks' inclusion records. This directly contradicted the schema's own stated goal of preserving the full block tree.

**Fix chosen:** PK is now `(net, block_height, block_hash, tx_hash)` — every column a transaction-inclusion record actually needs to be unique per network, fork, and transaction — plus a separate `UNIQUE (net, block_height, block_hash, position)` constraint preventing two transactions from occupying the same slot within one block. (The task brief offered a choice between this and `(net, block_height, block_hash, position)` as the PK with a separate uniqueness constraint on the tx_hash tuple; this revision picked the tx_hash-keyed PK because `tx_hash` is the natural external identity a caller looks up a transaction-inclusion record by — `position` is an internal ordinal, better expressed as a uniqueness constraint on top of the identity-keyed PK than as the PK itself.)

```sql
CREATE TABLE transactions (
  net              text        NOT NULL,
  tx_hash          bytea       NOT NULL CHECK (octet_length(tx_hash) = 32),
  block_height     bigint      NOT NULL CHECK (block_height >= 0),
  block_hash       bytea       NOT NULL CHECK (octet_length(block_hash) = 32),
  position         integer     NOT NULL CHECK (position >= 0),
  kind             text        NOT NULL CHECK (kind IN ('regular', 'system')),
  protocol_version integer     NOT NULL CHECK (protocol_version >= 0),
  result           text        CHECK (result IN ('success', 'partial_success', 'failure') OR result IS NULL),
  raw_blob_hash    bytea       NOT NULL REFERENCES chain_blobs(hash),
  synced_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (net, block_height, block_hash, tx_hash),
  UNIQUE (net, block_height, block_hash, position),
  FOREIGN KEY (net, block_height, block_hash) REFERENCES blocks (net, height, block_hash)
) PARTITION BY RANGE (block_height);

CREATE INDEX transactions_by_hash ON transactions (tx_hash);
```

**A real FK to `blocks` is now enforced** — the original draft had none ("No cross-table FK to `transactions`" was stated as a deliberate range-partition/hot-path trade-off, but reviewers flagged this specific direction — `transactions` → `blocks` — as a real gap, since transaction rows are only ever written after their containing block row already exists, unlike the parent-link backfill-ordering concern that genuinely applies to `blocks.parent_hash`). **Empirically confirmed working** against a real Postgres 17 instance while revising this migration: an FK from one range-partitioned table (`transactions`, partitioned by `block_height`) to another (`blocks`, partitioned by `height`), both referencing/referenced columns in the same domain, is accepted by Postgres and correctly rejects (a) a transaction referencing a wholly nonexistent block, and (b) a transaction whose `block_height`/`block_hash` pair doesn't jointly match any real `blocks` row (both cases tested directly with real inserts against the real migration's tables).

**v3 audit fixes (minor items):** `protocol_version` gained `CHECK (protocol_version >= 0)` — the v2 doc claimed "nonnegative checks throughout" but this column had none, an actual gap in that claim, not just an omission from this list. The v2 `transactions_by_block ON (net, block_height, block_hash)` index was **dropped**: it is a strict left-prefix of the PK's own btree index `(net, block_height, block_hash, tx_hash)`, so Postgres already satisfies any `(net)` / `(net, block_height)` / `(net, block_height, block_hash)` lookup — including the FK's own existence checks — off the PK index directly; the separate index bought no distinct access pattern, only extra write-amplification and storage on every insert. `transactions_by_hash` is kept: `tx_hash` alone is *not* a PK left-prefix (the PK's first column is `net`), so "look up a transaction by hash alone, across every block and fork" is a genuinely distinct access pattern the PK index cannot serve.

**v3 audit fix — blob-role integrity.** `raw_blob_hash` now has a `BEFORE INSERT OR UPDATE OF raw_blob_hash` trigger requiring a matching `chain_blob_roles (blob_hash, role='tx_raw')` row to already exist — see §4.1's `chain_archive_assert_blob_role` writeup for the shared mechanism and its empirical verification.

Otherwise directly matches §3.3's live-confirmed split: `kind`/`result` mirror the indexer's own `variant`/`transaction_result` columns; `raw_blob_hash` is where the opaque SCALE payload (§3.2) lives.

### 4.4 `bridge_observations` — NEW build-now table (reclassified from "defer")

**Audit item 3.** The original draft deferred bridge/governance data (cnight registrations, D-parameter/system-parameter history) on two grounds: (a) "the indexer already has it" — correctly flagged by reviewers as not a real justification for a store that exists specifically to survive an indexer wipe (the indexer having the data is exactly the failure mode this store exists to be independent of); (b) "replay-recoverable from raw transaction bytes" — the real justification in principle, but **never actually tested** (no genesis-to-event reconstruction was performed against this or any other category).

**This deferral was worse than merely untested — it was actively contradicted by the design's own evidence.** Bridge/governance observations are carried in Substrate **inherents**, which live in the block **body**, not in `transactions` (§2, §3.7). `blocks.body_blob_hash` is nullable "until body/extrinsics sync lands" (§4.2) and body sync is unscheduled. So even once "replay from raw bytes" is taken as the mechanism, the raw bytes this v1 schema actually captures (`transactions.raw_blob_hash`) do not contain bridge observations at all — they are simply absent from what v1 archives, not merely unparsed. The original design doc's own §9 acknowledged `cnight_registrations` is "partly Cardano-side... not cleanly re-derivable from Midnight block replay," which directly contradicts using "replay-recoverable" as the justification for deferring this specific category.

**Fix:** reclassified to build-now — a lean table following the exact same "queryable metadata + blob reference" pattern as `transactions`, so it doesn't require solving body/extrinsics sync at all: `raw_blob_hash` points directly at the specific observation's own raw bytes (extracted and archived independently, registered under the `chain_blob_roles` `'bridge_observation'` role), not at a reconstructed block body.

```sql
CREATE TABLE bridge_observations (
  net               text        NOT NULL,
  block_height      bigint      NOT NULL CHECK (block_height >= 0),
  block_hash        bytea       NOT NULL CHECK (octet_length(block_hash) = 32),
  observation_index integer     NOT NULL CHECK (observation_index >= 0),
  kind              text        NOT NULL CHECK (kind IN ('cnight_registration', 'system_parameters_d', 'spo_registration', 'other')),
  raw_blob_hash     bytea       NOT NULL REFERENCES chain_blobs(hash),
  synced_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (net, block_height, block_hash, observation_index),
  FOREIGN KEY (net, block_height, block_hash) REFERENCES blocks (net, height, block_hash)
) PARTITION BY RANGE (block_height);

CREATE INDEX bridge_observations_by_kind ON bridge_observations (kind);
```
`kind`'s value set (`cnight_registration`, `system_parameters_d`, `spo_registration`, `other`) mirrors the indexer tables actually confirmed live in §3.7/§3.8; `spo_registration` is included even though SPO data itself remains **not needed** as its own category (§7) — this is the shape for "if a bridge-adjacent SPO observation is ever archived here," not a commitment to build SPO archival now.

**v3 audit fix — blob-role integrity.** `raw_blob_hash` now has a `BEFORE INSERT OR UPDATE OF raw_blob_hash` trigger requiring a matching `chain_blob_roles (blob_hash, role='bridge_observation')` row to already exist — see §4.1.

### 4.5 `verifier_key_observations` — v3 redesign of the "build now" VK addition (replaces v2's `verifier_keys`)

The indexer has **no dedicated VK archive at all** today (confirmed: no `verifier_keys`-equivalent table in the live schema, §3) — this remains the one category where UmbraDB adds coverage the indexer genuinely lacks. What changed in v3 is the shape, not the decision to build it.

**v2's shape (`verifier_keys`, `PRIMARY KEY (vk_hash)`) had two gaps, both raised in the round-2 audit:**

**(a) The CHECK only enforced one direction.** v2's `CHECK (scope <> 'contract' OR contract_address IS NOT NULL)` only enforced `scope='contract' => contract_address IS NOT NULL` — but the v2 doc's own comment claimed the full **iff**: "`contract_address` IS NOT NULL ⇐⇒ `scope = 'contract'`". A protocol-scoped row with a non-null `contract_address` was silently accepted, contradicting the doc's own stated invariant. Fixed with `CHECK ((scope = 'contract') = (contract_address IS NOT NULL))`, which is a real biconditional. **Empirically verified against a real Postgres 17 instance:** both illegal combinations are rejected (`scope='protocol'` with a non-null address; `scope='contract'` with a null address), and both legal combinations are accepted.

**(b) `PRIMARY KEY (vk_hash)` alone was too narrow — confirmed by reading the ledger source directly, not assumed.** The design doc's own §4.5 text already claimed "a protocol-circuit VK's bytes may legitimately be identical across networks running the same protocol version," but the v2 schema didn't actually act on that claim — a single-row-per-hash table cannot record more than one context for the same key. This revision checked the claim against `transient-crypto/src/proofs.rs` and `ledger/src/structure.rs` directly:

- `VerifierKey`'s `Serializable::serialize` writes only the inner `MidnightVK` bytes (`SerdeFormat::Processed`) with no network ID, contract address, or deployment-specific salt anywhere in the encoding (`proofs.rs:501-514`). `Tagged::tag()` returns the fixed constant `"verifier-key[v6]"` for *every* instance (`proofs.rs:382-389`) — a format-version marker, not a per-key identifier. So the content-addressed hash of a VK is a pure function of the compiled circuit, full stop: two networks running the same protocol version, or two contract deployments of the same circuit/template, produce byte-identical VK content and therefore the identical hash.
- `structure.rs:2692-2696`'s `SingleUpdate::VerifierKeyInsert(EntryPointBuf, ContractOperationVersionedVerifierKey)` attaches a VK to one specific contract's own per-entry-point map. Nothing about this prevents the *same* circuit (and therefore the same VK bytes/hash) being inserted under different entry points, in different contracts at different addresses, or the *same* protocol circuit being observed on multiple networks.

**Conclusion: keys are genuinely shared across networks and across contract deployments, not a hypothetical edge case** — so `PRIMARY KEY (vk_hash)` was a real modeling bug, not an acceptable simplification. Fixed by splitting the old single table in two, per the task's suggested shape:

- **The content-addressed half needed no new table.** `chain_blobs (hash -> bytes)` already *is* "vk_hash -> key bytes," and `chain_blob_roles (role = 'verifier_key')` (§4.1, itself a v3 addition) already tracks "this hash is known to be a VK." Building a third, redundant content-keyed table here would just duplicate that.
- **`verifier_key_observations`** is the new table — the "each place/context this key was actually seen" junction the task asked for:

```sql
CREATE TABLE verifier_key_observations (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vk_hash           bytea       NOT NULL REFERENCES chain_blobs(hash),
  net               text        NOT NULL,
  scope             text        NOT NULL CHECK (scope IN ('protocol', 'contract')),
  tag               text        NOT NULL,
  contract_address  bytea,
  first_seen_height bigint      NOT NULL CHECK (first_seen_height >= 0),
  synced_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'contract') = (contract_address IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT (vk_hash, net, scope, contract_address, tag)  -- v4: see below
);

CREATE INDEX verifier_key_observations_by_contract ON verifier_key_observations (contract_address) WHERE contract_address IS NOT NULL;
```

The natural key the task originally specified — `(vk_hash, net, scope, contract_address, first_seen_height)` — cannot itself be the `PRIMARY KEY`: Postgres requires every PK column to be `NOT NULL`, and `contract_address` is legitimately `NULL` for protocol-scoped rows, which would make every protocol-scoped observation un-insertable. Used a surrogate `id` PK plus `UNIQUE NULLS NOT DISTINCT (...)` instead (PG15+; this repo targets PG17).

**v4 audit fix — the uniqueness key itself was wrong, not just the choice of PK vs. surrogate (both round-3 reviewers converged on this).** Two related problems, both in the v3 key `(vk_hash, net, scope, contract_address, first_seen_height)`:

- **Missing `tag`.** This section's own text, immediately below, has always said `tag` names the circuit/entry-point role a key was observed playing in a given context, and that the *same* VK bytes can legitimately recur under a *different* `tag` within the same `(vk_hash, net, scope, contract_address)` — e.g. the same circuit reused for two different entry points of one contract. But `tag` was never actually part of the v3 uniqueness key, so two such distinct, legitimate observations collided on every other column and one silently lost the insert (or, under an upsert pattern, silently overwrote the other) — a real data-loss bug, not a hypothetical one. Fixed by adding `tag` to the key.
- **`first_seen_height` shouldn't be part of identity at all.** With it in the key, the same logical `(vk_hash, net, scope, contract_address, tag)` context could be inserted repeatedly with different claimed `first_seen_height` values, producing multiple contradictory "first-seen" rows for what should be exactly one observation context. `first_seen_height` is a *mutable fact about* an identity ("the earliest height this context has been seen at, so far, given everything synced so far") — not part of the identity itself. Fixed by removing it from the key; callers now maintain it via:
  ```sql
  INSERT INTO verifier_key_observations (vk_hash, net, scope, tag, contract_address, first_seen_height)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (vk_hash, net, scope, contract_address, tag)
  DO UPDATE SET first_seen_height = LEAST(verifier_key_observations.first_seen_height, EXCLUDED.first_seen_height);
  ```

**Empirically verified against a real Postgres 17 instance:** (1) two *different* protocol-scoped observations sharing every column except `tag` (same `vk_hash`/`net`, both `contract_address IS NULL`) are now correctly accepted as two distinct rows — the exact data-loss scenario the v3 key produced is closed; (2) the `ON CONFLICT`/`LEAST` upsert above, run twice against the same `(vk_hash, net, scope, contract_address, tag)` context with `first_seen_height` values `100`, then `50`, then `999`, correctly collapses to a single row holding `50` (the minimum across all three) rather than three contradictory rows; (3) a plain (non-upsert) `INSERT` of a true duplicate context is still correctly rejected with `unique_violation`. `NULLS NOT DISTINCT` (unchanged from v3) is still what makes this dedup logic work correctly for protocol-scoped rows at all — ordinary `UNIQUE` treats every `NULL` `contract_address` as distinct from every other `NULL`, which would silently defeat the whole key for that case.

**The now-redundant `verifier_key_observations_by_vk_hash` index (v3) was dropped, confirmed rather than assumed.** The corrected `UNIQUE NULLS NOT DISTINCT (vk_hash, net, scope, contract_address, tag)` constraint's own backing btree index has `vk_hash` as its leading column, so any `vk_hash`-only lookup is already a leftmost-prefix scan of that index — the same reasoning already applied to dropping `transactions_by_block` in v3 (§4.3). **Confirmed, not assumed**, via `EXPLAIN (COSTS OFF) SELECT * FROM verifier_key_observations WHERE vk_hash = $1` against a real Postgres 17 instance: the plan is a `Bitmap Index Scan` on the UNIQUE constraint's own backing index, with no separate `by_vk_hash` index present at all. `verifier_key_observations_by_contract` is kept — `contract_address` is *not* the leading column of the UNIQUE index, so a contract-only lookup remains a genuinely distinct access pattern that index cannot serve.

`tag` stays on this table rather than being a property of the content-addressed hash: it names the circuit/entry-point role a key was observed playing in a given context, which is a property of the *observation*, not of the bytes — the same bytes observed in two different contexts could legitimately carry the same or a different human-readable `tag`.

**v3 audit fix — blob-role integrity.** `vk_hash` now has a `BEFORE INSERT OR UPDATE OF vk_hash` trigger requiring a matching `chain_blob_roles (blob_hash, role='verifier_key')` row to already exist — see §4.1. **v4 audit fix:** that role row, once created, can no longer be silently deleted out from under a live `verifier_key_observations` row either — see §4.1's `chain_blob_roles_guard_removal_trigger` writeup.

`verifier_key_observations` remains unpartitioned (unchanged rationale from v2's `verifier_keys`): observation count is bounded by fixed protocol circuits × networks + deployed contracts × entry points, nowhere near block/tx volume.

### 4.6 Range partitioning strategy

`blocks`, `transactions`, `bridge_observations` are `PARTITION BY RANGE` on their height column.

**Bucket size is now a single real constant, not a hardcoded-vs-"configurable" contradiction (audit finding).** The original draft's DDL hardcoded `1000000` inline while its prose claimed bucket size was "configurable" via `pg_partman`'s own config — the two statements were never actually connected. This revision resolves the contradiction by choosing one side and being explicit about it: `src/postgres/migrations/chain_archive/partition-config.ts` exports `CHAIN_ARCHIVE_HEIGHT_PARTITION_SIZE = 1_000_000` as the actual single source of truth, imported by the migration everywhere a partition bound is computed. This is a **build-time** constant, not a runtime/env-configurable parameter — a genuinely runtime-configurable bucket size would require generating partition DDL from external config at deploy time, out of scope for this pass. If that ever becomes necessary, changing this one constant and re-deriving future partitions from it is the intended path; the doc no longer claims a configurability this migration doesn't actually provide.

**The `DEFAULT`-partition operational trap is addressed, not just noted (audit finding, flagged by two reviewers as a real operational hazard).** The original draft created exactly one bounded partition (`[0, 1000000)`) plus an unbounded `DEFAULT` catch-all from day one — meaning any height at or beyond 1,000,000 falls into `DEFAULT` immediately, and rolling that over later requires detaching a partition that may already hold a large, unbounded number of rows. This revision instead **pre-creates `CHAIN_ARCHIVE_PRECREATED_PARTITIONS = 5` bounded buckets ahead of genesis** (`[0, 1M), [1M, 2M), [2M, 3M), [3M, 4M), [4M, 5M)` — 5,000,000 blocks of headroom) plus one `DEFAULT` beyond that, so a healthy deployment should never actually write into `DEFAULT` in practice.

#### v4 rewrite — the rollover runbook, rebuilt from four reproduced failures, run end-to-end for real

**v4 audit fix (CRITICAL — both round-3 reviewers independently reproduced real failures against real Postgres, top priority of this revision).** The v3 procedure below this heading looked plausible and was written up as "empirically verified end-to-end," but two independent reviewers actually ran it and found it wasn't reproducible as written. Re-run from scratch this round, every claim below is backed by a command actually executed against a real `postgres:17-alpine` container and its actual output, not a paraphrase.

**The four concrete ways the v3 procedure failed, each reproduced first, before designing the fix:**

1. **Retained FK constraints block the parent detach.** After `ALTER TABLE transactions DETACH PARTITION transactions_default`, the detached table is a completely ordinary standalone table now — except it *keeps* the FK constraint(s) it had while it was a partition, still pointing at `blocks`. The v3 text asserted DETACHing children first would let the parent DETACH succeed; it does not. Reproduced:
   ```
   $ psql -c 'ALTER TABLE blocks DETACH PARTITION blocks_default;'
   ERROR:  removing partition "blocks_default" violates foreign key constraint "transactions_default_net_block_height_block_hash_fkey1"
   DETAIL:  Key (net, block_height, block_hash)=(net1, 150, \x02) is still referenced from table "transactions_default".
   ```
   Inspecting `pg_constraint` on the detached child shows *three* FK constraints survive the detach: one named after the original parent table (`transactions_net_block_height_block_hash_fkey`, `confrelid = blocks`) and two internal per-referenced-partition clones (`confrelid = blocks_p0`, `confrelid = blocks_default`). Dropping the first one — the one matching the original parent table's own generated name — was confirmed to **cascade and drop the other two automatically**; there is no need to enumerate or drop the internal clones individually.
2. **`duplicate_table` on "create new tables with the same names."** The detached relations genuinely still exist under their original names until explicitly renamed. Reproduced: `CREATE TABLE blocks_default PARTITION OF blocks DEFAULT` immediately after detach, with no rename first, fails with `relation "blocks_default" already exists`. A real `ALTER TABLE ... RENAME TO ..._staging` step is required and is now spelled out below, not implied.
3. **A write-race window between resuming writes and attaching the new bounded partition.** Recreating `DEFAULT` (and thereby letting writes resume) before the new bounded partition is attached lets a write land in the not-yet-covered range, which then makes the `ATTACH`/`CREATE ... PARTITION OF` for that range fail. Reproduced: with `blocks_default` freshly recreated and `blocks_p1` not yet attached, `INSERT INTO blocks (..., height, ...) VALUES (..., 160, ...)` succeeds into `DEFAULT`; the subsequent `CREATE TABLE blocks_p1 PARTITION OF blocks FOR VALUES FROM (100) TO (200)` then fails:
   ```
   ERROR:  updated partition constraint for default partition "blocks_default" would be violated by some row
   ```
4. **`DETACH PARTITION CONCURRENTLY` does not work in this scenario.** Reproduced directly, run as its own top-level statement (its own documented requirement):
   ```
   $ psql -c 'ALTER TABLE transactions DETACH PARTITION transactions_default CONCURRENTLY;'
   ERROR:  cannot detach partitions concurrently when a default partition exists
   ```
   Unconditional — it fails regardless of `DEFAULT`'s size or contents. **Removed as a suggested fallback entirely.**

**Additionally confirmed (not previously stated correctly): `ATTACH`/`CREATE ... PARTITION OF` is not metadata-only/instant while a `DEFAULT` partition exists on the target table**, even when the new partition is empty and non-overlapping. Proven by lock contention, not inference: a background session held only a `SHARE` lock on an *empty* `blocks_default` for ~15s; a concurrent `CREATE TABLE blocks_p2 PARTITION OF blocks FOR VALUES FROM (200) TO (300)` (a disjoint, brand-new, empty partition) blocked for the full duration of that lock (measured: ~12s) before completing. Postgres must take a conflicting lock on — and validate — the `DEFAULT` partition on every bounded-partition attach as long as `DEFAULT` exists, regardless of whether `DEFAULT` currently holds any row that would actually violate the new bound. **The design doc's cost/downtime claims are corrected accordingly: this procedure is not "effectively zero downtime" for any step performed while a live `DEFAULT` partition exists on the target table**, only for the parts of the procedure below that are deliberately arranged to avoid having a `DEFAULT` present at all during the window that matters.

**The corrected procedure, fully concrete, run end-to-end against a real Postgres 17 instance** (schema shaped exactly like `blocks`/`transactions`/`bridge_observations` — same PK/FK shape, `PARTITION BY RANGE`, a bounded `[0,100)` bucket plus `DEFAULT` pre-populated with overflow rows at heights 150 and 175, matching this design's real bucket/DEFAULT layout at smaller scale for a fast test run):

1. **Steady state.** Monitor `max(height)` in `blocks` (or the `chain_archive.watermarks` canonical-tip cursor, §5) against the upper bound of the highest bounded partition shared by `blocks`/`transactions`/`bridge_observations` (they use the same bucket boundaries, sharing `partition-config.ts`'s constants).
2. **Steady state.** When the tip crosses within some margin (e.g. 20%) of that bound, attach a new bounded partition on **all three tables** for the same `[lo, hi)` range: `CREATE TABLE blocks_pN PARTITION OF blocks FOR VALUES FROM (lo) TO (hi)`, and the same for `transactions_pN`/`bridge_observations_pN`. **Correction from v3: this is not free even here** — per the lock-contention proof above, this still takes a lock on (and validates against) each table's live `DEFAULT` partition, which is empty in the healthy case but the lock/validation step still happens; it is cheap, not literally metadata-only. This should be the *only* path ever exercised on a healthy deployment — steps 3+ exist purely for the "monitoring was missed" recovery case.
3. **Recovery (only if step 1's monitoring was missed and `DEFAULT` already holds rows for what should have been the next bounded range).** Pause writers for this schema first (application-level — e.g. hold the same schema-scoped advisory lock `migrate.ts`'s `runMigrations` already uses) and do not resume them until step 3g confirms it's safe. Every command below was run verbatim against the real Postgres 17 instance described above, and the full result set after each step matched expectations exactly (see the verification transcript after step 3g).

   **(a) Detach children before the parent** — load-bearing ordering, confirmed by testing the reverse order and observing exactly the failure quoted above:
   ```sql
   ALTER TABLE transactions DETACH PARTITION transactions_default;
   ALTER TABLE bridge_observations DETACH PARTITION bridge_observations_default;
   ```
   **(b) Drop the retained FK constraint on each detached child** — required before the parent can be detached (failure #1 above); one `DROP CONSTRAINT` per child, naming the constraint that matches the *original parent table's own* generated FK name (this cascades and removes the internal per-partition clones too):
   ```sql
   ALTER TABLE transactions_default
     DROP CONSTRAINT transactions_net_block_height_block_hash_fkey;
   ALTER TABLE bridge_observations_default
     DROP CONSTRAINT bridge_observations_net_block_height_block_hash_fkey;
   ```
   **(c) Now detach the parent** — succeeds, since the only rows that were still referencing it are no longer FK-constrained:
   ```sql
   ALTER TABLE blocks DETACH PARTITION blocks_default;
   ```
   **(d) Rename every just-detached table out of the way** — required before a fresh `DEFAULT` (or a renamed-in-place bounded partition) can reuse that name (failure #2 above):
   ```sql
   ALTER TABLE blocks_default               RENAME TO blocks_default_staging;
   ALTER TABLE transactions_default         RENAME TO transactions_default_staging;
   ALTER TABLE bridge_observations_default  RENAME TO bridge_observations_default_staging;
   ```
   **(e) Reattach the staging data as correctly-bounded partitions BEFORE recreating `DEFAULT` or resuming writers** — this ordering, not "recreate `DEFAULT` immediately for near-zero downtime," is what actually closes the write race (failure #3 above): as long as no `DEFAULT` exists on a table, there is no partition for an out-of-range write to land in at all, so it fails loudly and immediately instead of racing silently. In the common case — a staging table's entire height span falls inside one target bucket `[lo, hi)`, true whenever monitoring lagged by less than one bucket width — this is a straight rename + `ATTACH`, no data copy, parent before children (matching ordinary FK-validation ordering):
   ```sql
   ALTER TABLE blocks_default_staging RENAME TO blocks_p1;
   ALTER TABLE blocks ATTACH PARTITION blocks_p1 FOR VALUES FROM (100) TO (200);

   ALTER TABLE transactions_default_staging RENAME TO transactions_p1;
   ALTER TABLE transactions ATTACH PARTITION transactions_p1 FOR VALUES FROM (100) TO (200);

   ALTER TABLE bridge_observations_default_staging RENAME TO bridge_observations_p1;
   ALTER TABLE bridge_observations ATTACH PARTITION bridge_observations_p1 FOR VALUES FROM (100) TO (200);
   ```
   If a staging table's contents instead span *more than one* target bucket (monitoring was missed for longer), split it before reattaching, per bucket, in ascending order: `CREATE TABLE blocks_pN (LIKE blocks INCLUDING ALL)`, `INSERT INTO blocks_pN SELECT * FROM blocks_default_staging WHERE height >= lo AND height < hi`, `DELETE FROM blocks_default_staging WHERE height >= lo AND height < hi` (safe here, unlike the original broken idea of deleting from a still-live `DEFAULT`, because `blocks_default_staging` is a free-standing table no longer part of the live FK-checked hierarchy) — repeat per bucket, `ATTACH` each (parent before its matching `transactions`/`bridge_observations` bucket), until the staging table is empty, then `DROP` it.
   **(f) Only now recreate empty `DEFAULT` partitions on all three tables** — every bounded range this deployment has ever actually seen data for is already covered by the time writers resume:
   ```sql
   CREATE TABLE blocks_default               PARTITION OF blocks DEFAULT;
   CREATE TABLE transactions_default         PARTITION OF transactions DEFAULT;
   CREATE TABLE bridge_observations_default  PARTITION OF bridge_observations DEFAULT;
   ```
   **(g) Resume writers.**

   **Verification, run against the real container after the full sequence above:** every original row (blocks at height 10/150/175, matching transactions, one bridge_observations row at height 150) present, correctly repartitioned (`blocks_p0` holds height 10, `blocks_p1` holds 150/175 — same for the sibling tables), zero rows landed in either freshly-recreated `DEFAULT` partition. A write made *after* step 3g into the newly-bounded range (`height = 160`) was accepted and correctly routed into `blocks_p1`/`transactions_p1`. The FK is still correctly enforced post-rollover: a transaction inserted afterward referencing a nonexistent block hash was correctly rejected with `foreign_key_violation`. Final row counts: `blocks_p0 = 1, blocks_p1 = 3` (2 original + 1 new); `transactions_p0 = 1, transactions_p1 = 3`; `bridge_observations_p1 = 1` — no data loss, no orphaned rows, no errors anywhere in the sequence.
4. `pg_partman` (or an equivalent scheduled job runner) remains the recommended way to *automate* step 2 on a timer across all three tables — this pass still does not build that automation, but the procedure above is concrete, tested, and immediately executable without it.

---

## 5. Migration lineage, schema placement — Tier-1.5 (audit item 5)

**Unanimous across all three reviewers:** per `design/design.md` §0's tier semantics, chain-scoped archival data does not belong inside the `tier1_wallet` schema (that's wallet/checkpoint persistence), but it's also explicitly NOT a fork of the official indexer's own schema (that would be Tier 2, and re-coupling to the indexer's shapes would defeat the point of this store existing independently of it). The original draft's §9 flagged this as an open architectural question rather than resolving it; this revision resolves it.

**Resolution: its own dedicated Postgres schema (`chain_archive`) and its own migration file numbering/lineage**, structurally separate from `tier1_wallet`'s `000`–`004` sequence:

- `src/postgres/migrations/chain_archive/000_schema.ts` is **not a new file** — it is `migration000` (the existing `src/postgres/migrations/000_schema.ts`), reused as-is. That migration's `up(sql, schema)` was already fully schema-parameterized (`CREATE SCHEMA IF NOT EXISTS <schema>` + a `<schema>._migrations` bookkeeping table scoped to whatever `schema` string is passed in) — nothing about it assumed `tier1_wallet` specifically, so running it a second time against a *different* schema name bootstraps an independent `_migrations` table scoped to that schema, with no changes needed to the migration itself.
- `src/postgres/migrations/chain_archive/001_chain_archive_core.ts` is the new file — everything in §4 (`chain_blobs`, `chain_blob_roles`, `blocks`, `transactions`, `bridge_observations`, `verifier_key_observations`, `watermarks`).
- `src/postgres/migrations/chain_archive/index.ts` exports `chainArchiveMigrations: Migration[] = [migration000, chainArchiveCore]` — the lineage array.

**The one small addition `migrate.ts` needed** (checked first, per the task's explicit instruction not to over-engineer a generic multi-schema framework): `RunMigrationsOptions` gained one new optional field, `migrations?: Migration[]`, defaulting to the existing (now-renamed) `tier1WalletMigrations` array. `runMigrationsImpl` reads `opts.migrations ?? tier1WalletMigrations` once, and uses that resolved `lineage` array everywhere it previously used the hardcoded `migrations` array — including generalizing the schema-bootstrap step to `lineage[0]` instead of a hardcoded `migration000` reference, so a future third lineage that didn't happen to start with a schema-bootstrap migration would surface as a real, visible bug rather than a silently-wrong hardcoded assumption. `Migration` (the interface) is now exported so `chain_archive/index.ts` can type against it without duplicating the shape. No new generic "lineage registry," no dynamic lineage discovery, no config-driven lineage selection — a caller passes the array it wants, or gets the default it always got.

**Not wired into any executing path.** Nothing in this repo's application code today calls `runMigrations(sql, { schema: "chain_archive", migrations: chainArchiveMigrations })` — this lineage remains exactly as unregistered/inert as `005_chain_archive.ts` was before this revision, per the task's explicit scope. (It was, however, **directly applied against a real local Postgres 17 instance** during this revision as an empirical check — see §4.2/§4.3's transcripts — which is different from being wired into any deployed runner path.)

**`watermarks` reuse — resolved, not left as a note.** The original draft proposed reusing the existing `tier1_wallet.watermarks` table (`003_watermarks.ts`) with a `kind='chain_archive'` row for the canonical-tip cursor. Now that chain-archive data lives in its own schema and lineage specifically to decouple from `tier1_wallet`, reaching across that boundary to write into a table owned and migration-managed by the `tier1_wallet` lineage would silently re-couple the two tiers this split exists to keep apart — a `chain_archive`-only backup/restore or a `tier1_wallet` schema change could no longer be reasoned about independently. **Resolution: `chain_archive` gets its own local watermark-equivalent table** — same proven shape (`kind`/`key`/`value` pair, `fillfactor = 90` for HOT-update-friendly high-frequency cursor writes) as `003_watermarks.ts`, deliberately duplicated as an independent table within `001_chain_archive_core.ts` rather than cross-schema-referenced. A chain-archive canonical-tip cursor is written as, e.g., `kind='chain_archive', key='canonical_tip:' || net` in this local table — the generic `(kind, key)` shape doesn't need to change to carry network scoping in the key itself, consistent with how the existing `tier1_wallet.watermarks` table already leaves key-structure conventions to its callers.

---

## 6. Reorg / rollback handling — summary

No indiscriminate cascade-delete anywhere in this schema. The policy: (1) every received block/transaction/bridge-observation is inserted once and never deleted; (2) `is_canonical`/`status` on `blocks` is the only thing that changes on a reorg, flipped by application code walking the new canonical chain from the fork point using `parent_hash`, and now DB-enforced to stay internally consistent and unique-per-height (§4.2); (3) the canonical tip is a local `chain_archive.watermarks` row (§5), not a new cursor table.

**`block_undo` is cut entirely from this revision (audit item 4 — unanimous across all three reviewers).** The original draft reserved a `block_undo` table as a per-block diff record "for a future mutable projection table" that does not exist yet. All three reviewers converged on the same finding: it has zero function in an insert-only v1 (blocks/transactions are never deleted, only status-flipped, so they need no undo record at all), its payload format was left unspecified, and reserving the shape now buys nothing a future migration — introduced alongside whatever projection actually needs undo semantics, once one is designed — wouldn't provide just as well. It was **deliberately cut, not silently dropped**: if a future mutable current-state projection (e.g. a materialized current-UTXO-set or current-contract-state table) is ever built and genuinely needs "apply stored inverse" rollback, its undo-record shape should be designed together with that projection, informed by its actual payload needs, rather than guessed at in advance with no consumer to validate it against.

This directly implements the Bitcoin-Core-derived recommendation from the original research and explicitly rejects Cardano db-sync's cascade-delete-on-reorg pattern for the reason db-sync itself doesn't need to worry about: this store's job includes being usable when it is the *only* surviving copy, not just a queryable mirror of a chain that is always independently available elsewhere.

---

## 7. The data categories — explicit judgment calls (revised)

| Category | Call | Reasoning |
|---|---|---|
| **Blob store, blocks, transactions** (the core three) | **Build now** | §4.1–4.3; the substrate everything else hangs off. |
| **Bridge/governance observations** | **Build now** *(reclassified from "defer" — audit item 3)* | §4.4. The original "defer, replay-recoverable" justification is contradicted by this data living in block bodies (not `transactions`) and by the design's own acknowledgment that `cnight_registrations` is partly Cardano-side and not cleanly re-derivable from Midnight block replay alone. A lean, build-now table closes the gap without waiting on unscheduled body/extrinsics sync. |
| **ZK verifier-key metadata** | **Build now** (minimal) | The indexer has **no dedicated VK archive at all** today (§3) — the one category where UmbraDB adds coverage the indexer genuinely lacks, not a duplicate. |
| **Shielded ledger events (zswap)** | **Defer — UNVERIFIED** *(flag added — audit item 3)* | Indexer's `ledger_events`/`zswap_nullifiers` already cover this richly (§3.5, live `ZswapOutput` rows confirmed), and the "cheaply re-derivable from raw tx replay" argument (Erigon's E3-receipts precedent) is the right shape of argument for this category — **but it has not actually been tested**. No genesis-to-event replay reconstruction has been performed. This deferral should be treated as provisional, not established, until an end-to-end genesis→event replay test is run against `transactions.raw` for this category specifically. |
| **Unshielded UTXO events** | **Defer — UNVERIFIED** | Same caveat as zswap: indexer's `unshielded_utxos` covers full create→spend lifecycle (§3.4, live data confirmed) and is plausibly replay-recoverable from `transactions.raw`, but this has not been tested end-to-end. |
| **Dust generation/registration** | **Defer — UNVERIFIED** | Same caveat: indexer's `dust_generation_info`/`dust_nullifiers` cover this (§3.5, 85 live rows confirmed); replay-recoverability is plausible but untested. |
| **Contract state/actions** | **Defer** | Heaviest and least-validated category — **zero live instances on this devnet** (§3.6), so even the shape confirmation is schema-only. A real design (Erigon-style `state_current`+`state_history` diff pair) deserves its own pass once contracts are actually in active use on a target network. |
| **Ledger events, generic** | **Not needed as a full copy** | A full typed mirror of the indexer's `ledger_events` table is exactly the zswap/unshielded/dust duplication argued against above, generalized. `bridge_observations` (§4.4) is the one narrower slice of "generic events" this pass builds, because it specifically is not replay-recoverable the way the others are believed (but not yet proven) to be. |
| **SPO/staking data** | **Not needed in UmbraDB** | Lowest priority: Cardano-side registration data, not Midnight ledger state; indexer's coverage is comprehensive and zero live rows on this devnet mean there's nothing yet to validate a UmbraDB copy against. |

---

## 8. Migration

`src/postgres/migrations/chain_archive/001_chain_archive_core.ts` (plus the reused `../000_schema.ts` and the new `partition-config.ts`/`index.ts`) implements §4/§5 in the repo's established style — `sql(schema)`-parameterized, no ORM, matching `002_checkpoint_store.ts`/`004_transaction_history.ts` structurally, with one addition: the partition-bound DDL uses `sql.unsafe()` rather than a normal tagged-template call, because a `CREATE TABLE ... PARTITION OF ... FOR VALUES FROM ($1) TO ($2)` bind parameter is **empirically confirmed** (tested directly against a real Postgres 17 instance with `postgres.js`) to be rejected by Postgres at parse time ("could not determine data type of parameter $1") — a partition bound must be a constant-folded expression at DDL-parse time, not a bind-time value. The `.unsafe()` calls are safe because the interpolated values are exclusively: a schema name already validated by `assertValidSchemaName` (checked twice — once by `runMigrations` before any migration runs, and redundantly at the top of this migration's own `up()`, so it is still safe to call directly, bypassing the runner), fixed string literals owned by this file, and integers computed from this module's own `partition-config.ts` constants — never external input. This matches the one other place this repo already does the same thing for the same underlying reason (`transaction-lease.ts`'s `sql.unsafe("set local statement_timeout = ...")`).

It is **not** registered in `migrate.ts`'s default `tier1WalletMigrations` lineage and has not been run against any application database — per the task's explicit scope, it is a genuine, syntactically-correct migration lineage sitting in its own directory, callable only if a caller explicitly opts into it via `RunMigrationsOptions.migrations`, which nothing in this repo's application code does. (It *was* applied directly, as an empirical check during this revision, against an ephemeral local Postgres instance spun up and torn down solely for that purpose — see §4.2/§4.3 — which does not constitute wiring it into any real runner path.)

---

## 9. Generalizing the verifiable-snapshot L0–L3 layers to full-chain-archive snapshots

`design/verifiable-snapshot-design.md` establishes, for **wallet-state** snapshots, the theorem this design inherits verbatim: *the DB is never a source of correctness, only of availability; every check reduces to an on-chain commitment, which reduces to finality.* The same four layers generalize to a **chain-archive** snapshot with no new primitive required — but §L1 below states precisely what that check does and does not prove; see the v3 audit fix immediately following the layer list for why the doc previously overclaimed here.

- **L0 (anchor).** Instead of a wallet's zswap/dust/unshielded root, the anchor is the **block-tree's own frontier**: `{net, height N, block_hash, parent_hash chain}`. Blocks are already intrinsically hash-linked (`parent_hash` in every header, §3.1/§4.2) — recomputing "does my stored chain from genesis to N hash-chain correctly to the tip's `parent_hash` at every step" is a strictly simpler offline check than the wallet case's Merkle-tree rehash, because it's a linear walk over already-stored rows, not a tree recomputation over selectively-disclosed leaves.
- **L1 (bounded-scan continuity of ONE header chain — not a general completeness proof).** Because every block header commits to its parent, a contiguous stored range `[M, N]` with no gap and a verified hash-chain walk proves that **one specific header chain, as stored, is internally continuous end to end** — no header can be silently omitted from the middle of that one hash-chained sequence without breaking the walk. That is a real, useful, cheaply-checkable property, but it is a narrower claim than "the archive is complete," and this doc previously stated the broader claim without qualification (v3 audit finding, one round-2 reviewer, §10.9).
- **L2 (remote/untrusted-DB hardening).** Applies unchanged in spirit: if this archive is ever served from a hosted/replicated UmbraDB instance rather than a trusted local one, the same AES-GCM-at-rest / anti-rollback / multi-device concerns apply to the archive's own monotonic sync watermark (`chain_archive.watermarks`, §5) exactly as they apply to a wallet snapshot's `seq`.
- **L3 (on-chain self-certification).** The `verifiable-snapshot` design's Compact "Attested Manifest Root" contract is explicitly designed with a Merkle-committed structured snapshot root over domain-separated sections — a second commitment slot for a `chainArchiveManifestRoot` (committing to, e.g., `sha256` over the ordered `(net, height, block_hash)` sequence UmbraDB has actually archived) is a structurally identical addition, not a new mechanism.

**v3 audit fix — completeness-claim overclaim (new finding, one round-2 reviewer, a documentation-accuracy fix, no schema change).** The pre-v3 text above stated that the L1 hash-chain walk proves the archive is "complete." That is not accurate, and this doc's own established honesty discipline elsewhere (§7's UNVERIFIED flags, §3.6's "confirmed absent, not confirmed present") calls for the same precision here. What the L1 walk actually proves, and does not prove:

- **Proves:** for the *one* chain of header rows actually walked (genesis to the row picked as the endpoint), the stored sequence is internally continuous — every `parent_hash` in the walk correctly links to the previous row's `block_hash`, with no gap. This is a real, cheap, useful check.
- **Does NOT prove fork completeness.** `blocks` deliberately stores the full block tree, not just the canonical chain (§4.2) — but a single canonical-chain walk from genesis to tip says nothing about whether every non-canonical/orphaned block UmbraDB ever received was actually retained. A missing orphaned-fork row does not break the canonical walk at all.
- **Does NOT prove transaction or bridge-observation completeness.** Nothing about a `blocks`-only hash-chain walk touches `transactions` or `bridge_observations` — a block row can exist, hash-chain correctly, and still have zero of its real transactions archived, and the walk would not detect it.
- **Does NOT prove body/extrinsics integrity**, and structurally *cannot* with this v1 schema even in principle: each header carries `extrinsics_root` (§3.1), which is exactly the commitment that would let a verifier recompute and check "do the transactions I have for this block actually match what the header committed to" — but `blocks.body_blob_hash` is nullable (§4.2, pending unscheduled body/extrinsics sync), so the raw block body needed to recompute `extrinsics_root` is often simply not present. Even where `transactions` rows exist for a block, this v1 schema has no code path that recomputes `extrinsics_root` from them and compares.

A genuine completeness claim (fork completeness + transaction-set completeness + body integrity) is real, separate future work, gated on body/extrinsics sync landing and an explicit `extrinsics_root`-recomputation check being built — not something the current parent-hash walk gets for free. This connection point is otherwise deliberately left at the concept level — the task that will formalize L0–L3 for chain-archive snapshots is a separate, later design-council process, gated on this schema being stable.

---

## 10. Residual limitations and open questions for the design council

1. **Contract state/actions is genuinely unvalidated.** Deferred per §7, but worth restating: not a single live contract instance existed on the devnet used for this pass's verification. Any future build-out of this category should re-run the same live-confirmation discipline against a devnet with real contract activity before committing to a schema.
2. **Zswap/unshielded/dust deferral is UNVERIFIED, not established** (§7) — the single biggest remaining honesty gap this revision could not fully close within its own scope. An actual end-to-end genesis→event replay test (parse `transactions.raw` for a real range of blocks and confirm the reconstructed zswap/unshielded/dust events match the indexer's own recorded events for the same range) has still not been performed. This revision's contribution is turning an unqualified "replay-recoverable" assertion into an explicit UNVERIFIED flag — not performing the test itself, which is real follow-up work.
3. **Partition bucket sizing** (`CHAIN_ARCHIVE_HEIGHT_PARTITION_SIZE = 1_000_000`, `CHAIN_ARCHIVE_PRECREATED_PARTITIONS = 5`) is a considered starting point (§4.6), not derived from real mainnet block-time/volume data, since none yet exists. Revisit once real non-devnet volume data is available.
4. **`chain_blobs`/`chain_blob_roles` are unpartitioned in v1** — revisit once `tx_raw` volume is large enough that list-partitioning by role (or a hash-prefix range scheme) pays for its own operational cost.
5. **`net` is a safety-rail column, not (yet) a physical partitioning dimension** (§4.2) — correct for the expected single-network-per-deployment shape, but a future multi-network-in-one-archive deployment would need `LIST (net)`-then-`RANGE (height)` sub-partitioning, not built here.
6. **No FK enforcement on `blocks.parent_hash`** (§4.2) — an explicit, unchanged trade-off (out-of-order reorg backfill), not an oversight; application-level invariant checks must exist wherever `blocks` is actually written to, which this pass does not build (migration-only scope).
7. **This design does not touch `midnight-storage-core`'s GC gap** noted in the original research brief (every `.persist()` in `midnight-node` today is unbalanced by any `.unpersist()` call site) — that is a `midnight-node` upstream concern, out of scope for a Postgres schema design.
8. **Partition rollover automation** (§4.6's runbook) is a documented manual/scriptable, empirically-verified procedure, not built automation — `pg_partman` or an equivalent scheduler remains the recommended way to run it on a timer across all three tables, still not wired up in this pass.
9. **The L1 chain-continuity check (§9) proves header-chain continuity, not archive completeness** — restated here per this revision's own honesty discipline (v3 audit finding): fork completeness, transaction/observation completeness, and body/`extrinsics_root` integrity are all separate, currently-unproven properties. A genuine completeness claim is real future work gated on body/extrinsics sync landing and an explicit `extrinsics_root`-recomputation check being built.
10. ~~`chain_blob_roles` completeness enforcement (§4.1) is insert/update-time only, not delete-time~~ — **closed in v4**: `chain_blob_roles_guard_removal_trigger` now enforces this at delete/update time too, with the concurrency race closed via row-level locking on both sides (§4.1). Left struck through rather than deleted, per this doc's own honesty-discipline precedent (§7, §3.6) — it was a real, correctly-identified gap at the time it was written, not a phantom one.

---

## 11. Phasing table

| Capability | v1 (this pass) | Deferred (near-term) | Not needed in UmbraDB |
|---|---|---|---|
| Content-addressed blob store (`chain_blobs`/`chain_blob_roles`) | ✅ §4.1 | list-partition by role once volume justifies it | |
| Block tree (`blocks`, `is_canonical`/status, canonical-uniqueness enforced) | ✅ §4.2 | `LIST(net)` sub-partitioning if multi-network-in-one-archive is ever needed; `pg_partman` rollover automation | |
| Transaction metadata (`transactions`, FK to `blocks`) | ✅ §4.3 | | |
| Bridge/governance observations (`bridge_observations`) | ✅ §4.4 *(reclassified from deferred)* | | |
| Verifier-key metadata (`verifier_key_observations`) | ✅ §4.5 *(v3: split from single-row-per-hash `verifier_keys` into a content-addressed hash + multi-context observation junction, per direct ledger-source confirmation that VK content is genuinely shared across networks/contracts)* | | |
| Shielded ledger events (zswap) | | **UNVERIFIED** — needs an end-to-end genesis→event replay test before this deferral is trusted | indexer already covers today |
| Unshielded UTXO events | | **UNVERIFIED** — same | indexer already covers today |
| Dust generation/registration | | **UNVERIFIED** — same | indexer already covers today |
| Contract state/actions | | full design pass once real contract activity exists to validate against | |
| Generic ledger-events mirror | | | superseded by narrower `bridge_observations` need |
| SPO/staking data | | | Cardano-side, indexer-comprehensive, zero devnet signal |
| L0–L3 chain-archive verification | conceptual sketch only (§9) | full design, gated on `feature/verifiable-snapshot` council ratification | |
| `block_undo` | | **cut entirely** (§6) — will be redesigned alongside whatever future mutable projection actually needs it, if one is ever built | |

---

*Grounding: three completed research passes (industry archival prior art; Midnight source/schema audit; UmbraDB live-schema confirmation) as condensed in the original task brief; live-devnet evidence captured directly in §3 (node RPC `localhost:9944`, indexer GraphQL `localhost:8088`, and a direct SQLite read of the indexer's own `/data/indexer.sqlite`), 2026-07-22; the v2 revision's own direct empirical Postgres testing (a real local `postgres:17-alpine` container, spun up and torn down solely for that revision) for the partial-unique-index-on-partitioned-table question (§4.2), the cross-partitioned-table FK question (§4.3), the generated-column/CHECK behavior (§4.1), and a full end-to-end application of the actual revised migration including the fork-PK-fix scenario (§4.3, §8); `design/design.md` §0 and `design/verifiable-snapshot-design.md` re-read directly, not from memory. **v3 additionally grounded in:** its own fresh empirical Postgres 17 testing (another disposable local container) for the `finalized`-CHECK behavior (§4.2), the blob-role trigger-on-partitioned-table propagation and enforcement behavior (§4.1), the `verifier_key_observations` CHECK-biconditional and `UNIQUE NULLS NOT DISTINCT` dedup behavior (§4.5), and the DETACH/re-ATTACH partition-rollover procedure across FK-linked tables (§4.6); a direct read of `transient-crypto/src/proofs.rs` and `ledger/src/structure.rs` (not assumed) for the verifier-key sharing finding (§4.5); and one committed automated test (`test/postgres/chain-archive-migrate.test.ts`) that actually runs `chainArchiveMigrations` against real Postgres and exercises the fork/dual-canonical/FK-violation scenarios end-to-end, run and confirmed passing as part of that revision (`npx vitest run`, full suite, no regressions; `npx tsc --noEmit`, clean). **v4 additionally grounded in:** a round-3 3-reviewer re-audit (Opus / Fable 5 / GPT-5.6 Sol) in which two reviewers independently reproduced real failures against real Postgres 17 rather than accepting the v3 prose; this revision's own fresh empirical re-verification of every one of those findings against another disposable local `postgres:17-alpine` container — the rollover runbook's four concrete failure modes and the corrected procedure's full end-to-end run (§4.6), the blob-role delete/update guard and its two-concurrent-session lock-ordering proof (§4.1), the `finalized`-monotonicity trigger (§4.2), and the verifier-key `tag`-in-key fix plus the `EXPLAIN`-confirmed redundant-index removal (§4.5); and an extended `test/postgres/chain-archive-migrate.test.ts` covering all four fixes with real negative-path assertions, run and confirmed passing (`npx vitest run`; `npx tsc --noEmit`, clean). No Midnight source modified; nothing committed to any node/indexer state; no migration run against any application database (only ephemeral, disposable test containers created and destroyed solely for verification, across all revisions).*
