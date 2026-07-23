# Full-Chain Storage — Design

**Branch:** `feature/full-chain-storage` · **Date:** 2026-07-22 · **Status:** Design draft for the design council's correctness-gate review (schema not yet applied to any live DB).
**Author role:** synthesizing three completed research passes (industry archival prior art, Midnight source/schema audit, UmbraDB's live schema) plus a direct live-devnet confirmation pass run for this document.

This document is **decisive** — it recommends one v1 schema and states what is deferred — but §9 flags genuinely open questions for the design council, including one architectural tension with `design/design.md` §0 this pass surfaced and did not resolve unilaterally.

---

## 1. Problem and core principle

UmbraDB's `tier1_wallet`-shaped schema (`_migrations`, `kv_current`/`kv_history`, `ckpt_*`, `watermarks`, `transaction_history`) persists **wallet-scoped** state. Nothing in it today survives an indexer wipe, a `midnight-indexer` schema migration, or a version bump that changes `midnight-indexer`'s own table shapes — because nothing in it is chain-scoped. `midnight-indexer` (confirmed live against `midnight-indexer:4.0.2` this session, §3) already holds a rich relational archive, but it is a dependency UmbraDB's own architecture forbids at runtime (`test/postgres/no-sdk-import-guard.test.ts`; `design/design.md`'s Tier-1/Tier-2 split) and its own deep Merkle-DAG arena state is pruned to a sliding window, not archived.

**The principle this design follows (from Erigon/geth-freezer/Bitcoin Core, cross-cut against the real Midnight data model):** split **raw, cheap, replay-capable payload** (block bytes, tx bytes, proof/VK blobs — content-addressed, append-only, never re-derived by parsing) from **lean, queryable metadata** (heights, hashes, parent links, canonical-chain status — exactly what a recovery or reconciliation workflow filters or joins on). Do **not** duplicate data the indexer already relationally archives well UNLESS UmbraDB's independent survival of an indexer wipe requires it, and do not archive data that is cheaply re-derivable from the raw payload once it exists (Erigon's E3 receipts precedent). This yields a schema that is deliberately smaller than a full indexer-schema mirror — it is a **survives-the-indexer** substrate, not an analytics replica.

---

## 2. Source grounding

- **Industry prior art**: Cardano db-sync (raw/queryable split, dictionary normalization, canonical-only + cascade rollback — flagged as a real limitation, not copied), Erigon (current+history/changeset split, don't archive the cheaply-recomputable), geth freezer / Bitcoin Core (append-only blob store separate from a rebuildable typed index; full block tree + per-block undo record, not cascade-delete), Solana (no early archival plan ⇒ costly multi-year retrofit — the cautionary case for building this now).
- **Midnight source, cited directly, re-verified live this session where noted:**
  - Header shape: `midnight-node/runtime/src/lib.rs:1157`, standard Substrate `generic::Header<BlockNumber,BlakeTwo256>` — **confirmed live**, §3.1.
  - Opaque SCALE-wrapped ledger tx: `pallets/midnight/src/lib.rs`'s `send_mn_transaction(origin, midnight_tx: Vec<u8>)` — **confirmed live**, §3.2 (the raw bytes literally begin with the ASCII tag `midnight:system-transaction[v6]:`).
  - Zswap: `midnight-ledger/zswap/src/structure.rs` + `ledger.rs` (`CoinCiphertext`, `Input`, `Output`, `Offer`, `State{coin_coms, nullifiers, past_roots}`).
  - Unshielded: `midnight-ledger/ledger/src/structure.rs:2857+` (`Utxo{value,owner,type_,intent_hash,output_no}`) — **confirmed live**, §3.4.
  - Dust: `midnight-ledger/ledger/src/dust.rs` (`DustOutput`, `DustGenerationInfo`, `DustSpend`, `DustRegistration`) — **confirmed live**, §3.5.
  - Contract: `midnight-ledger/onchain-state/src/state.rs` + `ledger/src/structure.rs:2400+` (`ContractState`, `ContractCall`, `ContractDeploy`) — schema confirmed via introspection only, **zero live instances on this devnet** (§3.6).
  - Events: `midnight-ledger/ledger/src/events.rs` (`Event{source, content: EventDetails}`) — **confirmed live**, §3.5/§3.7 (`ParamChange`, `DustInitialUtxo`, `DustGenerationDtimeUpdate`, `ZswapOutput` all observed).
  - Verifier keys: `transient-crypto/src/proofs.rs:377`, tag `verifier-key[v6]`.
  - Bridge/D-parameter/SPO: `midnight-node/primitives/system-parameters/src/lib.rs`; indexer's `cnight_registrations`, `system_parameters_d`, `spo_*` — **cnight_registrations and system_parameters_d confirmed live**, §3.8; `spo_*` schema-only (0 rows on this devnet).
- **UmbraDB's live schema** (`src/postgres/migrations/000_schema.ts`–`004_transaction_history.ts`, re-read this session): the `sql(schema)`-parameterized, no-ORM, raw-`postgres.js`-tagged-SQL migration convention this document's own migration stub (§7) follows; `ckpt_chunks` (`002_checkpoint_store.ts`) is the existing SHA-256-content-addressed blob table this design evaluates extending (§4.1 explains why it does not).
- **`design/design.md` §0** (re-read this session, not part of the original three-pass brief): UmbraDB already has a **Tier-1/Tier-2 split** — Tier 1 is this project's own `tier1_wallet`-schema checkpoint/temporal-KV/tx-history (what migrations 000–004 build); Tier 2 is a *separate, already-planned* "chain-mirror/indexer/analytics" tier that explicitly **forks the official indexer's own Postgres schema** plus TimescaleDB. This is a real, load-bearing prior decision this pass's schema sits next to, not on top of — flagged as an open question for the council in §9, not resolved here.
- **`feature/verifiable-snapshot` design** (`design/verifiable-snapshot-design.md`, read via `git show origin/feature/verifiable-snapshot:...`): the L0–L3 layering this document generalizes in §8.

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
Exactly the five fields `midnight-node/runtime/src/lib.rs:1157`'s standard Substrate header predicts: `parent_hash`, `number`, `state_root`, `extrinsics_root`, `digest.logs[]` — confirms the `blocks` table's queryable-column set (§5.2) with no surprises.

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
`raw` hex-decodes to ASCII `midnight:system-transaction[v6]:` + payload — this is `send_mn_transaction`'s opaque `Vec<u8>` (`pallets/midnight/src/lib.rs`), confirming the "raw transaction store is naturally a blob-store concern" claim: the wire format is itself domain-separated and self-tagged, exactly like `VerifierKey`'s `verifier-key[v6]` tag (`transient-crypto/src/proofs.rs:377`) — the same tagging convention recurs across the wire format, which is independent confirmation this is one coherent protocol-versioning scheme, not a one-off.

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
`regular_transactions` schema: `id, transaction_result('"Success"'), merkle_tree_root, start_index, end_index, paid_fees, estimated_fees` — confirms the CardanoDB-sync-style split (raw payload in one column, queryable result/root/index fields in sibling columns) UmbraDB's own `transactions` table (§5.3) follows.

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
returned, across the 26 genesis transactions: 22× `DustInitialUtxo`, 13× `DustGenerationDtimeUpdate`, 2× `ParamChange`, real `mn_addr_undeployed1...` owners and 32-byte hex hashes throughout (full JSON captured, one representative transaction pasted in §3.4). SQLite `ledger_events` variant/grouping distribution over the whole chain:
```
DustGenerationDtimeUpdate | Dust  | 13
DustInitialUtxo           | Dust  | 85
ParamChange                | Dust  | 2
ZswapOutput                | Zswap | 28
```
This is a direct, live match to the `Event`/`EventDetails` variant list in `ledger/src/events.rs` (`DustInitialUtxo`, `DustGenerationDtimeUpdate`, `ParamChange`, `ZswapOutput` all present with real rows) — and it is genesis-only data (no post-genesis dust/zswap activity on this idle devnet), an honest scope note carried into §6's judgment calls. `DustLedgerEvent` GraphQL introspection (`__type(name:"DustLedgerEvent"){possibleTypes{name}}`) returned exactly `ParamChange, DustInitialUtxo, DustGenerationDtimeUpdate, DustSpendProcessed` — four of `EventDetails`'s documented dust variants, live-confirmed as a closed set on this indexer version.

### 3.6 Contract state/actions — confirmed absent, not confirmed present

`__type(name:"ContractAction"){possibleTypes{name}}` → `ContractDeploy, ContractCall, ContractUpdate` (schema exists). SQLite: `contract_actions 0`, `contract_balances 0` rows. **Honest limitation:** this devnet has never had a contract deployed, so the contract-state shape (`ContractState{data,operations,maintenance_authority,balance}`) is confirmed only at the GraphQL-schema level, not against a real instance. Flagged explicitly in §6's judgment call for this category rather than papered over.

### 3.7 Governance / bridge

```
system_parameters_d: (id=1, block_height=0, block_hash=<32B>, timestamp=1754395200000,
                       num_permissioned_candidates=10, num_registered_candidates=0)
cnight_registrations: 3496 rows, e.g. (cardano_stake_key=<32B>, dust_address=<32B>, valid=1,
                       registered_at=1754395200000, block_id=1, utxo_tx_hash=<32B>, utxo_output_index=0)
```
Both real, live, non-trivial data — `cnight_registrations` in particular is a large, genuinely populated table (bridge-adjacent Cardano-stake-key → dust-address registrations), confirming the indexer's bridge/governance tables are live and worth deferring to (§6) rather than duplicating prematurely.

### 3.8 SPO/staking

`spo_identity`, `spo_epoch_performance`, `spo_history` etc. all present in the schema (`SPO`, `SpoIdentity`, `SpoComposite`, `EpochPerf`, `CommitteeMember` types in the GraphQL schema) but **zero rows** — this devnet has no registered stake pool operators. Schema-confirmed only, consistent with §6's "not needed in UmbraDB" call for this category (lowest archival priority; also the category furthest from "Midnight ledger state," being Cardano-side SPO registration data).

---

## 4. Schema design

### 4.1 `chain_blobs` — content-addressed blob store (new sibling table, NOT an in-place extension of `ckpt_chunks`)

**Decision: new table, not `ckpt_chunks` + a `kind` column.** Justification: `ckpt_chunks` is load-bearing for `CheckpointStore`'s specific lifecycle — its rows are reclaimed by a `NOT EXISTS`-against-`ckpt_manifest_chunks` GC query (`checkpoint-store.ts`) whose correctness depends on *every* row in `ckpt_chunks` being reachable only through that one junction table. Chain-archive blobs (block/tx/proof/VK bytes) have a **different, incompatible lifecycle**: they are referenced by `blocks`/`transactions`/`verifier_keys` rows that are themselves range-partitioned and effectively permanent (§4.2–4.3), never pruned by a manifest-completion event. Putting both in one physical table would force every future checkpoint-GC pass to also account for chain-archive referrers (or vice versa), coupling two independently-evolving modules' garbage-collection correctness through a shared table — the same kind of entanglement `design/design.md`'s Tier-1/Tier-2 schema split exists to prevent at the schema level. A sibling table with the same proven shape (SHA-256 PK, `bytea` payload) avoids this without losing any of the pattern's value.

```sql
CREATE TABLE chain_blobs (
  hash       bytea PRIMARY KEY,        -- sha256(data), same algorithm as ckpt_chunks
  kind       text  NOT NULL CHECK (kind IN ('block_header', 'block_body', 'tx_raw', 'proof', 'verifier_key')),
  data       bytea NOT NULL,
  size_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chain_blobs_kind ON chain_blobs (kind);
```
`kind` is a filter/diagnostic column only, not part of the key — content-addressing means identical bytes always collapse to one row regardless of logical role, which is correct (a block header and a tx body are never going to coincide, and if they did, deduplicating them is still correct, not a bug). No range partitioning in v1: hash is uniform-random, so there is no natural range key, and unlike `ckpt_chunks` (unpartitioned today) blob volume at devnet/early-mainnet scale doesn't yet justify the operational cost of list-partitioning by `kind`. Flagged as a v2 candidate once `tx_raw` volume dominates (§9).

This table is a deliberately good target for the sibling `feature/network-torrent` branch's retrieval work (SHA-256-keyed, content-addressed, `kind`-discriminated) — no design coordination needed beyond that shape being stable, per the task's framing; this document does no torrent/PKI design itself.

### 4.2 `blocks` — the block tree, not just the canonical chain

```sql
CREATE TABLE blocks (
  block_hash       bytea       NOT NULL,
  height           bigint      NOT NULL,
  parent_hash      bytea       NOT NULL,
  state_root       bytea       NOT NULL,
  extrinsics_root  bytea       NOT NULL,
  author           bytea,                              -- nullable: not every header carries an author digest item
  header_blob_hash bytea       NOT NULL REFERENCES chain_blobs(hash),
  body_blob_hash   bytea       REFERENCES chain_blobs(hash),   -- null until the body/extrinsics sync step lands
  is_canonical     boolean     NOT NULL DEFAULT false,
  status           text        NOT NULL DEFAULT 'seen' CHECK (status IN ('seen', 'canonical', 'orphaned', 'pruned')),
  finalized        boolean     NOT NULL DEFAULT false,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (height, block_hash)
) PARTITION BY RANGE (height);
```
Deliberate choices, stated rather than assumed:
- **`parent_hash` has no FK.** A declarative self-referencing FK across range partitions requires the referenced column set to include the partition key on both sides and complicates out-of-order backfill (a reorg-heavy resync often receives a child before its parent is durably committed). Parent-link integrity is an application-level invariant (checked by the module code that will consume this table), the same trade this project already made for `ckpt_manifest_chunks`'s ordering guarantee living outside the PK.
- **`block_hash` is not the sole primary key** — Postgres requires the partition key (`height`) in any unique constraint on a partitioned table, so the PK is `(height, block_hash)`. `block_hash` global uniqueness is trusted, not DB-enforced, on the same collision-negligibility basis `ckpt_chunks`'s SHA-256 PK already trusts.
- **Every received block is kept**, canonical or not (`is_canonical`/`status`) — the Bitcoin Core pattern from §A, chosen specifically because indiscriminate cascade-delete-on-reorg (Cardano db-sync's pattern) is a real limitation for a store whose entire purpose is being a recovery source of last resort, not just a query cache.
- **No cross-table FK to `transactions`** (§4.3) or into `block_undo` (§4.4) for the same range-partition/hot-path reasons as `parent_hash`.
- **The canonical tip pointer is not a new table** — it reuses the existing `watermarks` table (`kind='chain_archive', key='canonical_tip'`, `003_watermarks.ts`), which is already exactly "small, mutable, extremely-high-update-frequency cursor storage" (its own migration's `fillfactor=90` rationale applies verbatim here). No new "hot/cold split" table is needed for this one cursor.

### 4.3 `transactions` — metadata only, raw bytes via blob reference

```sql
CREATE TABLE transactions (
  tx_hash          bytea       NOT NULL,
  block_height     bigint      NOT NULL,
  block_hash       bytea       NOT NULL,
  position         integer     NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('regular', 'system')),
  protocol_version integer     NOT NULL,
  result           text        CHECK (result IN ('success', 'partial_success', 'failure') OR result IS NULL),
  raw_blob_hash    bytea       NOT NULL REFERENCES chain_blobs(hash),
  synced_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (block_height, tx_hash)
) PARTITION BY RANGE (block_height);
CREATE INDEX transactions_by_hash ON transactions (tx_hash);
CREATE INDEX transactions_by_block ON transactions (block_hash);
```
Directly matches §3.3's live-confirmed split: `kind`/`result` mirror the indexer's own `variant`/`transaction_result` columns (System vs Regular; `"Success"` et al.), `raw_blob_hash` is where the opaque SCALE payload (§3.2) lives — nothing about the payload's internal structure is modeled here, consistent with "index only what recovery workflows filter on" (hash, block, position, lifecycle — no attempt to decode zswap/unshielded/dust content out of `raw`, which is exactly the data the *deferred* categories in §6 would need to parse it).

### 4.4 `block_undo` — reserved per-block diff record, no cascade-delete

```sql
CREATE TABLE block_undo (
  block_height   bigint      NOT NULL,
  block_hash     bytea       NOT NULL,
  undo_blob_hash bytea       NOT NULL REFERENCES chain_blobs(hash),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (block_height, block_hash)
) PARTITION BY RANGE (block_height);
```
**Honest scope note:** `blocks` and `transactions` themselves are pure insert-only tables — reorg handling for them is exactly "flip `is_canonical`/`status` on the stale fork, flip it on the newly-canonical one," never a delete, so they need no undo record at all. `block_undo`'s payload format is intentionally unspecified at v1 (`undo_blob_hash` is opaque) — it exists as **reserved storage shape** for a future mutable `*_current` projection table (e.g., a materialized current-UTXO-set or current-contract-state table, both explicitly deferred in §6) that a reorg would need to roll back via "apply stored inverse" rather than a query-time recompute. Building that projection table is out of this pass's scope; reserving where its undo records would live is not.

### 4.5 `verifier_keys` — the one "build now" addition beyond the core three

```sql
CREATE TABLE verifier_keys (
  vk_hash           bytea       PRIMARY KEY REFERENCES chain_blobs(hash),
  scope             text        NOT NULL CHECK (scope IN ('protocol', 'contract')),
  tag               text        NOT NULL,          -- e.g. 'verifier-key[v6]', or a fixed protocol circuit name
  contract_address  bytea,                          -- non-null iff scope = 'contract'
  first_seen_height bigint      NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
```
Not range-partitioned — VK count is bounded by (fixed protocol circuits) + (deployed contracts), nowhere near block/tx volume, so §A's partitioning recommendation doesn't apply. See §6 for why this is the one genuinely new archival surface (the indexer has no dedicated VK table today).

### 4.6 Range partitioning strategy

`blocks`, `transactions`, `block_undo` are all `PARTITION BY RANGE` on their height column. The migration (§7) creates one bounded partition plus a `DEFAULT` catch-all per table — enough for the DDL to be immediately insert-ready at any height — and explicitly defers **operational partition rollover** (creating the next bucket ahead of time, migrating rows out of `DEFAULT`) to `pg_partman` or an equivalent scheduled job, per §A's recommendation, not built in this pass. Bucket size is left as a tunable (`pg_partman`'s own config, not hardcoded in DDL) rather than guessed here; a reasonable starting point mirroring common chain-indexer practice is 100k–1M blocks per partition, re-evaluated once real block-time/volume data from a non-devnet network is available.

---

## 5. Reorg / rollback handling — summary

No indiscriminate cascade-delete anywhere in this schema. The full policy: (1) every received block/transaction is inserted once and never deleted; (2) `is_canonical`/`status` on `blocks` is the only thing that changes on a reorg, flipped by application code walking the new canonical chain from the fork point using `parent_hash`; (3) `block_undo` reserves the storage shape a future mutable projection would need for "apply stored inverse" rollback, deferred until such a projection exists; (4) the canonical tip is a `watermarks` row, not a new cursor table. This directly implements §A's Bitcoin-Core-derived recommendation and explicitly rejects Cardano db-sync's cascade-delete-on-reorg pattern for the reason db-sync itself doesn't need to worry about: this store's job includes being usable when it is the *only* surviving copy, not just a queryable mirror of a chain that is always independently available elsewhere.

---

## 6. The nine data categories — explicit judgment calls

| Category | Call | Reasoning |
|---|---|---|
| **Blob store, blocks, transactions** (the core three) | **Build now** | §4.1–4.3; this is the substrate everything else hangs off. |
| **Reorg/undo records** | **Build now** (reserved shape only) | §4.4/§5; cheap, directly requested, and the honest v1 scope (no projection logic yet) is stated plainly rather than implied-complete. |
| **ZK verifier-key metadata** | **Build now** (minimal) | The indexer has **no dedicated VK archive at all** today (confirmed: no `verifier_keys`-equivalent table in the live schema, §3's table list) — this is the one category where UmbraDB adds coverage the indexer genuinely lacks, not a duplicate. VKs are small, permanent, content-addressed — a natural fit for `chain_blobs` at near-zero cost. |
| **Shielded ledger events (zswap)** | **Defer** | Indexer's `ledger_events`/`zswap_nullifiers` already cover this richly (§3.5, live `ZswapOutput` rows confirmed) and it is exactly the "cheaply re-derivable from raw tx replay" case Erigon's E3-receipts precedent argues against duplicating. UmbraDB's `raw_blob_hash` reference is sufficient to reconstruct it later if the indexer's copy is lost. |
| **Unshielded UTXO events** | **Defer** | Same reasoning; indexer's `unshielded_utxos` already tracks full create→spend lifecycle (§3.4, live data confirmed), and it's replay-recoverable from `transactions.raw`. |
| **Dust generation/registration** | **Defer** | Indexer's `dust_generation_info`/`dust_nullifiers` cover this (§3.5, 85 live rows confirmed); replay-recoverable. |
| **Contract state/actions** | **Defer** | Heaviest and least-validated category — **zero live instances on this devnet** (§3.6), so even the shape confirmation is schema-only. A real design (Erigon-style `state_current`+`state_history` diff pair, per §A) deserves its own pass once contracts are actually in active use on a target network; building it now against zero real data would be guessing. |
| **Ledger events, generic** | **Not needed as a full copy** | A full typed mirror of the indexer's `ledger_events` table is exactly the ZK/shielded/unshielded/dust duplication argued against above, generalized. What *is* built now is the narrower `block_undo` reserved-shape record (§4.4), which serves the actual need (rollback) without the duplication cost. |
| **Bridge events** | **Defer** | Indexer's `cnight_registrations` (3,496 live rows, §3.7) and (per the research brief) `protocol_bridge_events`/`bridge_claims` already cover this well; a durable UmbraDB-owned copy is legitimate future work once this pass's core schema is stable, not v1. |
| **Governance/D-parameter history** | **Defer** | Indexer's `system_parameters_d` (live, confirmed, §3.7) covers it; no changes observed yet on this devnet to even validate a "history" shape beyond the single current row. |
| **SPO/staking data** | **Not needed in UmbraDB** | Lowest priority: Cardano-side registration data, not Midnight ledger state; not cleanly re-derivable from Midnight block replay alone (it partly reflects Cardano-side facts observed via the bridge); indexer's coverage is comprehensive (`spo_identity`, `spo_history`, `spo_stake_snapshot/history`, `committee_membership`, `epochs`) and zero live rows on this devnet mean there's nothing yet to validate a UmbraDB copy against either. |

---

## 7. Migration stub

`src/postgres/migrations/005_chain_archive.ts` (this branch) implements §4.1–4.5 (`chain_blobs`, `blocks`, `transactions`, `block_undo`, `verifier_keys`) in the repo's established style — `sql(schema)`-parameterized, no ORM, matching `002_checkpoint_store.ts`/`004_transaction_history.ts` structurally. It is **not** registered in `migrate.ts`'s `migrations` array and has not been run against any database — per the task's explicit scope, it is a genuine, syntactically-correct migration file sitting in the migrations directory, not wired into the runner or `_migrations` bookkeeping.

---

## 8. Generalizing the verifiable-snapshot L0–L3 layers to full-chain-archive snapshots

`design/verifiable-snapshot-design.md` establishes, for **wallet-state** snapshots, the theorem this design inherits verbatim: *the DB is never a source of correctness, only of availability; every check reduces to an on-chain commitment, which reduces to finality.* The same four layers generalize to a **chain-archive** snapshot (a claim like "this `blocks`/`transactions` range, as stored in UmbraDB, is the complete and correct archive for `[0, N]`") with no new primitive required:

- **L0 (anchor).** Instead of a wallet's zswap/dust/unshielded root, the anchor is the **block-tree's own frontier**: `{height N, block_hash, parent_hash chain}`. Blocks are already intrinsically hash-linked (`parent_hash` in every header, §3.1/§4.2) — recomputing "does my stored chain from genesis to N hash-chain correctly to the tip's `parent_hash` at every step" is a strictly simpler offline check than the wallet case's Merkle-tree rehash, because it's a linear walk over already-stored rows, not a tree recomputation over selectively-disclosed leaves. The on-chain agreement check is the same shape as L0's wallet-case check: compare the locally-stored tip against `block(offset:{height:N})`'s committed hash (§3.1 already demonstrates this query working live).
- **L1 (bounded-scan completeness).** The wallet case's collapsed-tree range proof has a direct analogue: because every block header commits to its parent, a contiguous stored range `[M, N]` with no gap and a verified hash-chain walk **is** a completeness proof — no commitment can be silently omitted from the middle of a hash-chained sequence without breaking the chain, which is a weaker but genuinely simpler argument than L1's wallet-case Merkle-tree argument (no RFC 6962 fixed-size-tree reasoning needed, just chain-of-hashes contiguity).
- **L2 (remote/untrusted-DB hardening).** Applies unchanged in spirit: if this archive is ever served from a hosted/replicated UmbraDB instance rather than a trusted local one, the same AES-GCM-at-rest / anti-rollback / multi-device concerns apply to the archive's own monotonic sync watermark (`watermarks.kind='chain_archive'`, §4.2) exactly as they apply to a wallet snapshot's `seq`.
- **L3 (on-chain self-certification).** The `verifiable-snapshot` design's Compact "Attested Manifest Root" contract (§8 there) is explicitly designed with a Merkle-committed structured snapshot root over **domain-separated sections** (cursor/notes/nullifiers/history/dust/manifest) — a second commitment slot for a `chainArchiveManifestRoot` (committing to, e.g., `sha256` over the ordered `(height, block_hash)` sequence UmbraDB has actually archived) is a structurally identical addition, not a new mechanism. This is a sketch, not a spec: the actual circuit/contract change is out of this pass's scope and gated on the verifiable-snapshot design's own council ratification landing first.

This connection point is deliberately left at the concept level — the task that will formalize it is a separate, later design-council process, gated on this schema being stable (per the task brief).

---

## 9. Residual limitations and open questions for the design council

1. **The Tier-1/Tier-2 architectural tension (top, unresolved by this pass).** `design/design.md` §0 already commits to a Tier 2 that "forks the official indexer's Postgres schema" for chain-mirror/analytics duty, separate from this project's own Tier-1 migration sequence. This design's schema (§4) is deliberately much leaner than a full indexer-schema fork — a survives-the-wipe substrate, not an analytics mirror — and was built by literally following this task's instructions (extend the existing `src/postgres/migrations` sequence, generalize `ckpt_chunks`, match `002`/`004` conventions), which places it in the same migration numbering as Tier-1 tables. **This document does not resolve whether that's correct** — whether `005_chain_archive.ts` belongs in `tier1_wallet`-alongside-checkpoint-store (a "Tier 1.5"), or should instead be folded into or coordinated with the already-planned Tier-2 indexer-schema fork. Flagging this explicitly rather than picking a side is the single most important thing for the council to rule on before this schema is treated as final.
2. **Contract state/actions is genuinely unvalidated.** Deferred per §6, but worth restating: not a single live contract instance existed on the devnet used for this pass's verification. Any future build-out of this category should re-run the same live-confirmation discipline against a devnet with real contract activity before committing to a schema.
3. **Partition bucket sizing is a placeholder.** §4.6's 100k–1M range is a guess pending real block-time/volume data from a non-devnet network; `pg_partman` automation itself is not built.
4. **`chain_blobs` is unpartitioned in v1** — revisit once `tx_raw` volume is large enough that list-partitioning by `kind` (or a hash-prefix range scheme) pays for its own operational cost.
5. **No FK enforcement between `blocks`/`transactions`/`block_undo`** (§4.2/§4.3) — an explicit performance/partitioning trade-off, not an oversight; application-level invariant checks must exist wherever these tables are actually written to, which this pass does not build (migration-only scope).
6. **`block_undo`'s payload format is unspecified.** Reserved shape only (§4.4) — real content depends on whichever future mutable projection table needs it, not yet designed.
7. **This design does not touch `midnight-storage-core`'s GC gap** noted in the research brief (every `.persist()` in `midnight-node` today is unbalanced by any `.unpersist()` call site) — that is a `midnight-node` upstream concern, out of scope for a Postgres schema design, noted here only so it isn't mistaken for something this schema relies on or fixes.

---

## 10. Phasing table

| Capability | v1 (this pass) | Deferred (near-term) | Not needed in UmbraDB |
|---|---|---|---|
| Content-addressed blob store (`chain_blobs`) | ✅ §4.1 | list-partition by `kind` once volume justifies it | |
| Block tree (`blocks`, `is_canonical`/status) | ✅ §4.2 | `pg_partman` rollover automation | |
| Transaction metadata (`transactions`) | ✅ §4.3 | | |
| Reorg/undo reserved shape (`block_undo`) | ✅ §4.4 (shape only) | actual diff/apply-inverse logic, gated on a mutable projection table existing | |
| Verifier-key metadata | ✅ §4.5 | | |
| Shielded ledger events (zswap) | | duplicate only if a concrete indexer-wipe-survival need is identified | indexer already covers; replay-recoverable |
| Unshielded UTXO events | | same | indexer already covers; replay-recoverable |
| Dust generation/registration | | same | indexer already covers; replay-recoverable |
| Contract state/actions | | full design pass once real contract activity exists to validate against | |
| Generic ledger-events mirror | | | superseded by narrower `block_undo` need |
| Bridge events | | durable copy once schema stable | indexer already covers |
| Governance/D-parameter history | | durable copy once schema stable | indexer already covers |
| SPO/staking data | | | Cardano-side, indexer-comprehensive, zero devnet signal |
| L0–L3 chain-archive verification | conceptual sketch only (§8) | full design, gated on `feature/verifiable-snapshot` council ratification | |

---

*Grounding: three completed research passes (industry archival prior art; Midnight source/schema audit; UmbraDB live-schema confirmation) as condensed in the task brief; live-devnet evidence captured directly in §3 (node RPC `localhost:9944`, indexer GraphQL `localhost:8088`, and a direct SQLite read of the indexer's own `/data/indexer.sqlite`) this session, 2026-07-22; `design/design.md` §0 and `design/verifiable-snapshot-design.md` re-read directly, not from memory. No Midnight source modified; nothing committed to any node/indexer state; no migration run against any live database.*
