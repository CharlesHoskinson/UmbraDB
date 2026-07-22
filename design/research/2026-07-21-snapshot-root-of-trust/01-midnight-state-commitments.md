# Midnight on-chain state commitments, and what a wallet snapshot could anchor to

Angle 1/4 of the snapshot root-of-trust research. Scope: map every cryptographic
commitment Midnight's ledger/node/indexer already produce, show exactly how each
wallet package's local state and serialized snapshot relate to them, and pinpoint
the gaps between "what exists today" and "verify a restored snapshot against
block N without rescanning."

All citations are `repo/path:line` against the local clones (`~/repos/midnight-ledger`,
`~/repos/midnight-node`, `~/repos/midnight-indexer`, `~/repos/midnight-wallet`) unless
marked as a doc URL. Line numbers are as of the checkout read on 2026-07-21.

---

## 1. Two independent commitment layers exist, and they are easy to conflate

**Layer A — the Substrate/FRAME storage trie root** (`chain_getHeader().stateRoot`).
This is the generic, standard Substrate block header field, computed by
`frame_executive::Executive::finalize_block()` — a Merkle-Patricia trie over
*every* pallet's storage items in the runtime, not something midnight-node
overrides:

- `midnight-node/runtime/src/lib.rs:1416` — `Executive::finalize_block()` (the
  hook that fixes the header's storage root at end-of-block; standard FRAME
  machinery, no Midnight-specific code path).
- `midnight-node/node/src/service.rs:171-178` — genesis-block construction calls
  `op.set_genesis_state(...)` to get `state_root`, then
  `construct_genesis_block(state_root, ...)`; confirms the header's `stateRoot`
  slot is filled by the generic backend/trie mechanism, the same one used for
  every subsequent block.

One leaf of that generic trie is the single storage item `pallet_midnight::StateKey<T>`
(see Layer B). **The header's `stateRoot` is not itself a commitment to zswap
notes or dust UTXOs in any wallet-consumable form** — proving membership against
it would require a full Substrate state-trie proof, which nothing in the
indexer or wallet SDK currently requests (see §6, gap 1).

**Layer B — the ledger's own content-addressed state key**
(`pallet_midnight::StateKey<T>`, exposed as `midnight_ledgerStateRoot` /
`midnight_zswapStateRoot` RPCs). This is Midnight-specific and is the layer
that actually matters for a wallet.

- `midnight-node/pallets/midnight/src/lib.rs:344-347` (`on_finalize`): every
  block, `LedgerApi::apply_post_block_update(&state_key, block_context)`
  returns a new `state_root`, stored right back into `StateKey::<T>::put(state_root)`.
- `midnight-node/ledger/src/versions/common/mod.rs:297-308` (`apply_post_block_update`):
  `let state_root = api.tagged_serialize(&ledger.as_typed_key())?;` — the
  "state root" written on-chain **is** the typed content-address key of the
  in-memory `Ledger` struct.
- `midnight-ledger/storage-core/src/arena.rs:1505-1510` (doc comment on
  `Sp::hash`): *"Return hash of self and all children, cached from `<T as
  Storable>::hash()`. This is the root key of `self`, as a content-addressed
  Merkle node."* — i.e. every `Sp<T,D>` (storage pointer) in the ledger's data
  model is itself a Merkle-DAG node; hashing is recursive over children.
- `midnight-ledger/ledger/src/structure.rs:2975-2993` (`LedgerState<D>`): the
  struct that gets hashed. Fields, several marked `#[storable(child)]` (i.e.
  each is its own `Sp`, its own DAG subtree): `network_id`, `parameters`
  (child), `locked_pool`, `bridge_receiving`, `reserve_pool`,
  `block_reward_pool`, `unclaimed_block_rewards`, `treasury`, **`zswap`
  (child)**, `contract` (map), **`utxo` (child)**, `replay_protection`,
  **`dust` (child)**.
- RPC surface: `midnight-node/node/src/openrpc.rs:168-199` —
  `midnight_zswapStateRoot` ("Returns the Merkle root of the zswap … state
  tree") and `midnight_ledgerStateRoot` ("… of the overall ledger state"),
  both parameterised by an optional block hash (`at`), both **separate RPC
  calls from `chain_getHeader`**.
- The zswap-specific root is narrower than the whole ledger key: `get_zswap_state_root`
  in `midnight-node/ledger/src/versions/common/api/ledger.rs:115-119` is
  `state.coin_coms.rehash().root().unwrap()` — literally just the root of the
  zswap commitment tree (see §2), not the whole `LedgerState` DAG.

**Practical read:** `chain_getHeader().stateRoot` commits to *everything*
(all pallets) via a standard trie; `midnight_ledgerStateRoot` commits to just
the Midnight ledger's content-addressed DAG (zswap + dust + contracts + utxo +
parameters); `midnight_zswapStateRoot` commits to just the note-commitment
tree. A wallet building a snapshot anchor wants Layer B, specifically the
zswap/dust sub-roots — not the header field named in the task prompt as
"stateRoot".

---

## 2. The zswap commitment Merkle tree

Definition — `midnight-ledger/zswap/src/ledger.rs:37-48`:

```
pub struct State<D: DB> {
    pub coin_coms: MerkleTree<Option<Sp<ContractAddress, D>>, D>,
    pub coin_coms_set: HashMap<Commitment, (), D>,
    pub first_free: u64,
    pub nullifiers: HashMap<Nullifier, (), D>,
    pub past_roots: TimeFilterMap<Identity<MerkleTreeDigest>, D>,
}
```

- `coin_coms` is a fixed-height (`ZSWAP_TREE_HEIGHT = 32`,
  `midnight-ledger/zswap/src/lib.rs:23`), sparsely-represented, append-only
  Merkle tree of shielded coin/note **commitments** (both user coins and
  contract-owned coins — the `Option<Sp<ContractAddress,D>>` aux tag records
  which contract, if any, owns a leaf, used for `filter()` at
  `zswap/src/ledger.rs:211-239`).
- Appending: `apply_output`/`apply_transient`
  (`zswap/src/ledger.rs:95-124`, `126-165`) call
  `coin_coms.try_update_hash(first_free, coin_com.0, aux)`, then, if the
  output isn't relevant to a tracked contract, immediately
  `coin_coms.collapse(first_free, first_free)` to prune it back down to an
  opaque hash (privacy: non-owned leaves never need to be revealed).
- Root validity window: `post_block_update`
  (`zswap/src/ledger.rs:241-256`) rehashes the tree, inserts
  `(tblock, root)` into `past_roots`, then
  `past_roots.filter(tblock - Duration::from_secs(3600))` — **a spend's
  Merkle anchor is only valid for `global_ttl` (default 3600s = 1 hour,
  `midnight-ledger/ledger/src/structure.rs:1199,1271`) after being current.**
  A spend that references a root outside that window is rejected:
  `apply_input` at `zswap/src/ledger.rs:73-79` —
  `TransactionInvalid::UnknownMerkleRoot` if `!past_roots.contains(&inp.merkle_tree_root)`.
- Collapsing preserves the root exactly — this is the load-bearing property
  for wallet-side pruning: `midnight-ledger/transient-crypto/src/merkle_tree.rs:921`
  (comment on `Node.collapse`): *"NOTE: Collapsing leaves the hash invariant!"*
  So a wallet's own pruned/collapsed copy of the tree, once rehashed, has the
  *same* root as the full on-chain tree at the same `first_free`.
- Membership proof: `MerkleTree::path_for_leaf(index, leaf)`
  (`transient-crypto/src/merkle_tree.rs:1263-1289`) produces a standard
  sibling-hash authentication path (`MerklePath{leaf, path: Vec<MerklePathEntry>}`),
  which a spend's ZK circuit uses to prove inclusion under a chosen
  `past_roots` anchor.
- Sync primitive: `MerkleTreeCollapsedUpdate`
  (`transient-crypto/src/merkle_tree.rs:301-404`) is a concise "bridge" over a
  range of indices — a small set of subtree hashes computed by
  `MerkleTreeCollapsedUpdate::new` (binary-counter step sizes,
  `merkle_tree.rs:322-356`), letting a party advance a pruned tree past a
  range of foreign commitments **without learning their content or replaying
  the underlying transactions**. Indexer GraphQL:
  `zswapMerkleTreeCollapsedUpdate(startIndex, endIndex)`
  (`midnight-indexer/indexer-api/graphql/schema-v4.graphql:1258`).
- Wallet applies it: `zswap::local::State::apply_collapsed_update`
  (`midnight-ledger/zswap/src/local.rs:75-84`), surfaced to TS as
  `ZswapLocalState.applyCollapsedUpdate` /
  `CoreWallet.applyCollapsedUpdate` (`midnight-wallet/packages/shielded-wallet/src/v1/CoreWallet.ts:148-151`).

**Yes — a wallet's own note set can be proven a member of this tree at a
given block**, via `path_for_leaf` plus the block's `zswapMerkleTreeRoot`
(exposed per-block: `Block.zswapMerkleTreeRoot` /
`Block.zswapEndIndex` in `schema-v4.graphql:64,72`, and by the
`zswapMerkleTreeCollapsedUpdate` query directly). The proof exists purely
client-side against a root a wallet can independently recompute (§5-6).

---

## 3. The dust commitment tree and the dust generation tree

Two *separate* height-32 trees (`DUST_COMMITMENT_TREE_DEPTH = 32`,
`DUST_GENERATION_TREE_DEPTH = 32`, `midnight-ledger/ledger/src/dust.rs:140-141`),
structurally parallel to zswap but serving different roles:

**Commitment tree** — `DustUtxoState<D>`
(`midnight-ledger/ledger/src/dust.rs:892-897`):

```
pub struct DustUtxoState<D: DB> {
    pub commitments: MerkleTree<(), D>,
    pub commitments_first_free: u64,
    pub nullifiers: HashSet<DustNullifier, D>,
    pub root_history: TimeFilterMap<Identity<MerkleTreeDigest>, D>,
}
```

Commits to `DustCommitment` values — `DustPreProjection::commitment()`
(`dust.rs:398-404`, domain-separated `transient_commit` under tag
`mdn:dust:cm`) over `{initial_value, owner, nonce, ctime}`. This is the
direct analogue of zswap's `coin_coms_set`/leaves: one leaf per DUST UTXO
ever created.

**Generation tree** — `DustGenerationState<D>`
(`dust.rs:911-937`):

```
pub struct DustGenerationState<D: DB> {
    pub address_delegation: Map<UserAddress, DustPublicKey, D>,
    pub generating_tree: MerkleTree<DustGenerationInfo, D>,
    pub generating_tree_first_free: u64,
    pub generating_set: HashSet<DustGenerationUniquenessInfo, D>,
    pub night_indices: HashMap<InitialNonce, u64, D>,
    pub root_history: TimeFilterMap<Identity<MerkleTreeDigest>, D>,
}
```

Each leaf is a `DustGenerationInfo{value, owner, nonce, dtime}`
(`dust.rs:419-424`) — **not a static balance**. DUST is continuously
generated by locked NIGHT and decays after de-registration; a leaf
parameterises a piecewise-linear generate/cap/decay curve evaluated against
wall-clock time in `DustOutput::updated_value`
(`dust.rs:277-326`: phases — generating, constant-full, decaying,
constant-empty, driven by `params.night_dust_ratio` /
`generation_decay_rate` / `dust_grace_period`,
`INITIAL_DUST_PARAMETERS` at `dust.rs:1295-1299`: 5 DUST/NIGHT, ~1-week fill
time, 3h grace). So the generation tree commits to the *generation schedule*
(which NIGHT UTXOs are generating DUST, at what rate, since when), not to a
point-in-time DUST balance — balances must always be *computed*, even from
perfectly-verified tree data, using "now."

Both trees share the zswap tree's mechanics exactly: same rehash/collapse
semantics, same `root_history` TimeFilterMap windowed by `global_ttl`
(3600s), applied together in `DustState::post_block_update`
(`dust.rs:1265-1292`). A `DustSpend`'s ZK program checks historic roots for
*both* trees (`HistoricMerkleTree_check_root!` macro calls,
`dust.rs:573-604`) — proving a spend derives from a real generation entry
*and* that the new commitment/nullifier pair is correctly positioned.

Indexer surface (both marked `@beta`, i.e. explicitly unstable —
schema-v4.graphql:84,88,1284,1288):
`Block.dustCommitmentMerkleTreeRoot` / `Block.dustGenerationMerkleTreeRoot`
/ `Block.dustCommitmentEndIndex` / `Block.dustGenerationEndIndex`
(schema-v4.graphql:76-88), plus collapsed-update queries
`dustCommitmentMerkleTreeUpdate(startIndex,endIndex)` /
`dustGenerationMerkleTreeUpdate(startIndex,endIndex)`
(schema-v4.graphql:1284,1288) — same bridging mechanism as zswap.

Wallet-local mirror — `DustLocalState<D>`
(`midnight-ledger/ledger/src/dust.rs:1343-1357`):

```
pub struct DustLocalState<D: DB> {
    pub generating_tree: MerkleTree<DustGenerationInfo, D>,
    generating_tree_first_free: u64,
    pub commitment_tree: MerkleTree<(), D>,
    commitment_tree_first_free: u64,
    night_indices: HashMap<InitialNonce, u64, D>,
    dust_utxos: HashMap<DustNullifier, DustWalletUtxoState, D>,
    pub sync_time: Timestamp,
    pub params: DustParameters,
}
```

Holds pruned copies of *both* trees, plus a wall-clock `sync_time` (needed
because DUST value is time-dependent) and `params` (needed to re-evaluate
`updated_value` locally). Same collapse/apply-update methods as zswap
(`collapse_generation_tree`/`collapse_commitment_tree`/
`apply_collapsed_generation_update` etc., `dust.rs:1585-1680`).

---

## 4. How a wallet derives its state from the indexer stream

All three wallet kinds (shielded / dust / unshielded) follow the same
shape: subscribe to an indexer GraphQL subscription keyed by an
**indexer-internal, monotonically increasing event/transaction id** — not a
block number, not a Merkle index.

- **Shielded** — `midnight-wallet/packages/shielded-wallet/src/v1/Sync.ts`.
  Subscribes to `zswapLedgerEvents(id)` (`ZswapLedgerEvent{id,raw,maxId,
  protocolVersion}`, `schema-v4.graphql` ~2482). Cursor is
  `state.progress.appliedIndex` (`Sync.ts:218-230`, `290`). Each event is a
  serialized `ledger.Event`; applied via
  `ZswapLocalState.replayEventsWithChanges(secretKeys, events)`
  (`shielded-wallet/src/v1/CoreWallet.ts:167-183`), where `secretKeys:
  ledger.ZswapSecretKeys` is the shielded viewing/spending key material
  (coin secret key + coin/encryption public keys, `CoreWallet.ts:18-29`) used
  to decrypt/filter which commitments and nullifiers belong to the wallet.
- **Dust** — `midnight-wallet/packages/dust-wallet/src/v1/Sync.ts`.
  Subscribes to `dustLedgerEvents(id)` (`Sync.ts:295-303`), cursor
  `progress.appliedIndex` (`Sync.ts:274-288`), applied via
  `CoreWallet.applyEventsWithChanges(state, secretKey: DustSecretKey, rawEvents, timestamp)`
  (`Sync.ts:335-340`). **Distinctively, this sync service also independently
  fetches `block(offset:null)`** (the `BlockHash` query) to get
  `{hash, height, ledgerParameters, timestamp}` of the current chain tip
  (`Sync.ts:207-231`, `blockData()`), purely to get an up-to-date "now" for
  the DUST decay function — i.e. **the wallet SDK already round-trips
  through the exact `Block` GraphQL object that carries the commitment
  roots**, it just isn't asking for the root fields today.
- **Unshielded** — `midnight-wallet/packages/unshielded-wallet/src/v1/Sync.ts`.
  Subscribes to `UnshieldedTransactions({address, transactionId})`
  (`Sync.ts:80-98`), cursor `progress.appliedId`. No Merkle tree at all —
  NIGHT unshielded balance is a transparent UTXO set
  (`midnight-ledger/ledger/src/structure.rs:2948-2968`,
  `UtxoState<D>{utxos: HashMap<Utxo,UtxoMeta>}`), filtered server-side by
  address, no viewing key needed beyond the address itself.

**Common theme:** every sync cursor is an *indexer-implementation* stream
position (an event or transaction sequence id assigned by that particular
indexer instance), not a chain-native quantity. Nothing in the cursor itself
is independently checkable against node state.

---

## 5. What's actually in a serialized wallet snapshot today

**Shielded** — `midnight-wallet/packages/shielded-wallet/src/v1/Serialization.ts:66-120`:

```
{ publicKeys: {coinPublicKey, encryptionPublicKey},
  state: hex(ZswapLocalState.serialize()),   // coins, pending_spends/outputs, merkle_tree, first_free
  protocolVersion,
  offset: appliedIndex,                       // optional! Schema.optional(Schema.BigInt)
  networkId,
  coinHashes }
```
`ZswapLocalState` itself serializes exactly the struct at
`zswap/src/local.rs:49-55`: `coins`, `pending_spends`, `pending_outputs`,
`merkle_tree`, `first_free`. Restore path
(`CoreWallet.restoreWithCoinHashes`, `CoreWallet.ts:120-142`) only consumes
`syncProgress` (the event cursor) — **no block height, block hash, or
Merkle root field anywhere in the snapshot or the restore signature.**

**Dust** — `midnight-wallet/packages/dust-wallet/src/v1/Serialization.ts:62-114`:
same shape — `{publicKey, state: hex(DustLocalState.serialize()),
protocolVersion, networkId, offset: appliedIndex}`. `DustLocalState`
(`dust.rs:1343-1357`) does carry a wall-clock `sync_time`, but that's
locally-trusted input for the decay formula, not a chain-verified anchor —
still no root/height/hash field.

**Unshielded** — `midnight-wallet/packages/unshielded-wallet/src/v1/Serialization.ts:28-90`:
`{publicKey, state: {availableUtxos, pendingUtxos} (plain arrays — no
Merkle structure exists here at all), protocolVersion, appliedId, networkId}`.

Across all three, the *only* position information persisted is an
indexer-internal stream cursor, and even that field is declared
`Schema.optional` in every one of the three schemas — the current format
doesn't even guarantee a cursor is present, let alone a cryptographic
anchor.

---

## 6. Gap analysis — what's sufficient today, what's missing

### Already sufficient (no node/indexer changes needed)

1. **Every relevant tree already has a well-defined, independently
   recomputable root.** The `Sp<T,D>` content-addressing scheme
   (`storage-core/src/arena.rs:1505-1519`) means the zswap tree, both dust
   trees, and the whole `LedgerState` DAG all have deterministic hash roots,
   already exposed via `midnight_zswapStateRoot`/`midnight_ledgerStateRoot`
   RPCs (`node/src/openrpc.rs:168-199`) and, per-block, via the indexer's
   `Block` GraphQL type (`zswapMerkleTreeRoot`, `dustCommitmentMerkleTreeRoot`,
   `dustGenerationMerkleTreeRoot` + matching end-indices,
   `schema-v4.graphql:64-88`).
2. **Wallet-local pruned trees are root-identical to the full on-chain
   tree.** Because collapsing "leaves the hash invariant"
   (`transient-crypto/src/merkle_tree.rs:921`), a restored snapshot's
   `merkle_tree.rehash().root()` — computable **entirely offline, from the
   snapshot alone** — is bit-identical to the full on-chain zswap/dust tree
   root at the same `first_free`/end-index. This is the load-bearing fact:
   integrity checking doesn't require the wallet to hold any extra data
   beyond what it already serializes.
3. **The wallet SDK already has the plumbing to fetch a historical block's
   anchor tuple.** The dust-wallet's `blockData()`
   (`dust-wallet/src/v1/Sync.ts:207-231`) already calls the indexer's
   `block(offset)` query and already deserializes `ledgerParameters` from
   it — the same query, given `{height: N}` or `{hash: H}` instead of
   `null`, returns `zswapMerkleTreeRoot`/`zswapEndIndex` and both dust
   roots/end-indices for that exact historical block
   (`schema-v4.graphql:40-109`, `BlockOffset` at `:115-124`).
4. **The indexer recomputes roots itself rather than relaying a
   node-reported value.** `chain-indexer/src/domain/ledger_state.rs:159-176`
   shows the chain-indexer holds its own full `LedgerState`, applies every
   transaction through the same `midnight-ledger` crate, and computes
   `zswap_merkle_tree_root()` from its own replayed state — so an
   indexer-vs-node root cross-check is a genuine (if not consensus-level)
   agreement check between two independent re-executions of the same
   deterministic function, not "trust the indexer's say-so" in isolation.

### Strongest anchor candidate

Persist, alongside each wallet-kind's serialized local-state blob, the
**block anchor tuple for the relevant tree(s)** at serialization time:
`{blockHeight, blockHash, treeEndIndex, treeRoot}` — `zswapMerkleTreeRoot` +
`zswapEndIndex` for the shielded wallet; both dust roots + end-indices for
the dust wallet. On restore:

1. Deserialize the local state (as today).
2. **Locally** recompute `state.merkle_tree.rehash().root()` and compare to
   the persisted `treeRoot` — a zero-network, zero-replay self-consistency
   check that catches snapshot corruption/tampering/bit-rot immediately.
3. Query the indexer (or node RPC directly) for
   `block(offset:{height: blockHeight})` (or by hash) and compare its
   `zswapMerkleTreeRoot`/`zswapEndIndex` (etc.) against the persisted
   values. A match proves the snapshot is exactly correct as of block N —
   **without replaying a single transaction**.
4. Any further catch-up from block N to the chain tip then only needs the
   normal incremental sync path — `zswapMerkleTreeCollapsedUpdate`/
   `dust*MerkleTreeUpdate` deltas plus the ledger-event stream from that
   point forward — which is the cheap path the SDK already runs on every
   normal sync, not a rescan from genesis.

This requires **no new node or indexer capability** — every field involved
is already served today; the gap is purely that the wallet snapshot schema
doesn't currently capture or verify against it.

### Concrete gaps (what would need to change)

1. **No trust-minimized path from the anchor tuple back to consensus.**
   Step 3 above only proves *agreement* between the wallet's recomputation
   and whatever node/indexer answered the query — it does not prove that
   node/indexer is honest. There is no Substrate state-proof
   (`state_getReadProof`) or finality/header-chain verification wired into
   the wallet SDK today that would let a wallet verify `StateKey` (and by
   extension the zswap/dust roots nested in it) against `chain_getHeader`'s
   trie root in a way a light client could check without trusting the
   answering party. Closing this fully would need either a state-proof +
   finality-proof pipeline surfaced through the wallet SDK, or multiple
   independent indexer/node sources to cross-check against (weaker, but
   already possible with today's RPC surface).
2. **Dust root/end-index fields are `@beta`.** `dustCommitmentMerkleTreeRoot`,
   `dustGenerationMerkleTreeRoot`, and both `*MerkleTreeUpdate` queries are
   explicitly marked unstable (`schema-v4.graphql:84,88,1284,1288`,
   directive doc at `:2500-2508`: "Consumers should expect the marked
   surface to change without notice"). A production root-of-trust design
   anchored on these carries schema-stability risk until the beta tag is
   lifted.
2b. **The zswap root field itself is not `@beta`** (`zswapMerkleTreeRoot`,
   `schema-v4.graphql:64`) so the shielded-wallet anchor is on stable
   ground today; the dust anchor is not.
3. **The `global_ttl` spend-anchor window (3600s / 1 hour default,
   `structure.rs:1199,1271`) is easy to conflate with the indexer's
   *historical* per-block root storage, which has no such expiry** — the
   chain-indexer persists `zswap_merkle_tree_root` per transaction/block in
   its own database (`chain-indexer/src/domain/ledger_state.rs:171-180`)
   independent of the live ledger's rolling `past_roots`/`root_history`
   windows. A snapshot anchor recovered long after 3600s have elapsed is
   **still verifiable** via the indexer's historical block record (gap-3
   check above still works), but the recovered Merkle path/root is **no
   longer usable as a live spend anchor** — the wallet must re-derive a
   fresh path against a current root (via the normal collapsed-update sync)
   before it can spend. This distinction should be explicit in the
   root-of-trust design doc so "verified" isn't confused with
   "spend-ready."
4. **No first-class, versioned "snapshot manifest" ties state + cursor +
   anchor together with an enforced invariant.** Today the closest thing —
   `offset`/`appliedIndex` — is `Schema.optional` in all three
   Serialization.ts schemas (e.g.
   `shielded-wallet/src/v1/Serialization.ts:74`), so even the existing
   cursor isn't guaranteed present, let alone a future root field. Adding
   the anchor tuple should come with making the combination mandatory and
   internally cross-checked at deserialize time, not another optional
   field silently omittable.
5. **Contract-owned state has no dedicated anchor.** The `contract:
   Map<ContractAddress, ContractState<D>>` branch of `LedgerState`
   (`structure.rs:2987`) is folded into `midnight_ledgerStateRoot` but has
   no distinct per-contract commitment surfaced by the indexer — only the
   whole-ledger root, or a per-contract *filtered view* of the zswap tree
   (`contractZswapState(address)`, `schema-v4.graphql:102-109`, itself
   `@beta`). A wallet tracking contract-owned coins gets a zswap-tree
   anchor for those coins, but no independent anchor for a contract's
   non-zswap public state.

---

## Sources

Local source (read-only, per operating instructions):
- `~/repos/midnight-ledger`: `zswap/src/{lib.rs,ledger.rs,local.rs}`,
  `ledger/src/{structure.rs,dust.rs}`,
  `transient-crypto/src/merkle_tree.rs`,
  `storage-core/src/arena.rs`.
- `~/repos/midnight-node`: `node/src/{service.rs,openrpc.rs}`,
  `runtime/src/lib.rs`, `pallets/midnight/src/lib.rs`,
  `ledger/src/{host_api/ledger_9.rs,versions/common/mod.rs,versions/common/api/ledger.rs}`.
- `~/repos/midnight-indexer`: `indexer-api/graphql/schema-v4.graphql`,
  `chain-indexer/src/domain/ledger_state.rs`.
- `~/repos/midnight-wallet`: `packages/{shielded-wallet,dust-wallet,unshielded-wallet}/src/v1/{Sync.ts,Serialization.ts,CoreWallet.ts}`.

No source was modified; no code was committed.
