# Angle 4: SDK / Indexer Integration Surface for a Verifiable Snapshot Root-of-Trust

Scope: concrete file:line grounding for two future PRs — one to `midnight-indexer`, one to
`midnight-wallet` — that together would let a wallet serialize a snapshot stamped with a
verifiable anchor, and later restore it by checking that anchor against the indexer before
trusting it, resuming sync from the snapshot's point rather than rescanning.

Repos read (real source, not modified): `~/repos/midnight-wallet`, `~/repos/midnight-indexer`.
All paths below are relative to those repo roots unless stated otherwise.

---

## 1. SDK sync state machine + serialize/restore today

All three wallet variants (`shielded-wallet`, `unshielded-wallet`, `dust-wallet`) share one
shape, each under `packages/<variant>/src/v1/{Sync,Serialization}.ts`:

- **`SyncCapability.applyUpdate`** folds indexer-pushed updates into wallet state and advances a
  monotonic cursor called `appliedIndex` (shielded/dust) or `appliedId` (unshielded). Concrete
  cursor-advance sites: `shielded-wallet/src/v1/Sync.ts:304-308`, `dust-wallet/src/v1/Sync.ts:342-346`,
  `unshielded-wallet/src/v1/Sync.ts:130-132`.
- **Resume-from-cursor on reconnect** is already load-bearing logic, not incidental: all three
  compute `resumeFrom = appliedIndex - 1n` and document why the subscription cursor must be
  inclusive (`shielded-wallet/src/v1/Sync.ts:218-230`, `dust-wallet/src/v1/Sync.ts:278-288`, same
  comment verbatim in both — this is the exact mechanic a "resume sync from the snapshot's block"
  hook must key off).
- **`SerializationCapability.serialize/deserialize`** produces a JSON snapshot: hex-encoded
  ledger local state + `protocolVersion` + `networkId` + `offset` (the cursor) — and nothing else.
  No block hash, no Merkle root, no anchor of any kind is captured today:
  - Shielded: `shielded-wallet/src/v1/Serialization.ts:66-120` (`SnapshotSchema` at line 67).
  - Unshielded: `unshielded-wallet/src/v1/Serialization.ts:43-90`.
  - Dust: `dust-wallet/src/v1/Serialization.ts:62-114`.
- **Sync completion signal**: `SyncProgress.isStrictlyComplete()` / `isCompleteWithin(maxGap)`
  (`unshielded-wallet/src/v1/SyncProgress.ts:19-33`; shielded/dust wire the same predicate through
  `CoreWallet.updateProgress`, consumed at `shielded-wallet/src/ShieldedWallet.ts:310-314` and
  `dust-wallet/src/DustWallet.ts:426`). `FacadeState.isSynced` ANDs all three
  (`facade/src/index.ts:287-293`).
- **Restore → resume-sync entry point**, identical shape in all three wallets:
  `<Variant>Wallet.restore(serializedState)` is a **static** method that deserializes into a
  `CoreWallet` and calls `startFirst` to construct the instance
  (`shielded-wallet/src/ShieldedWallet.ts:238-243`; symmetric static methods at
  `dust-wallet/src/DustWallet.ts:295` and `unshielded-wallet/src/UnshieldedWallet.ts:226`), then a
  separate `.start(secretKeys)` call actually kicks off the sync stream
  (`shielded-wallet/src/ShieldedWallet.ts:264-266`). The integration test
  `wallet-integration-tests/test/serializationAndRestoration.integration.test.ts:81-90` is the
  live example of this two-step restore-then-start flow.

**Exact extension points for "verify before trust, then resume":**

1. **`restore()` is the seam.** It is a static factory, already the sole deserialization
   entry point, and already throws synchronously on schema/decode failure via
   `Either.getOrThrow` (`shielded-wallet/src/ShieldedWallet.ts:238-241`). A verifying variant
   (`restoreVerified()`) slots in here as a sibling static method that runs an async indexer
   round-trip *before* calling the same `startFirst`/`deserializeState` path — it does not need to
   touch `CoreWallet` internals at all.
2. **`SerializationCapability.serialize`** is the seam for stamping the anchor. Each variant's
   `buildSnapshot` (`shielded-wallet/src/v1/Serialization.ts:85-93`,
   `dust-wallet/src/v1/Serialization.ts:77-84`, `unshielded-wallet/src/v1/Serialization.ts:61-67`)
   already assembles a plain object before schema-encoding it; adding an `anchor` field there is a
   pure additive schema change (Effect `Schema.Struct` — new optional field, old snapshots still
   decode).
3. **`resumeFrom` computation in `Sync.ts`** is the seam for "resume from the snapshot's point" —
   it already IS how every restore resumes today (`appliedIndex`/`appliedId` from the
   deserialized snapshot flows straight into the subscription's start cursor). A verified restore
   changes nothing here; it only gates whether `restore()` is allowed to reach this point at all.
4. **`ledger.ZswapLocalState.merkleTreeRoot` (readonly `bigint | undefined`,
   `node_modules/@midnight-ntwrk/ledger-v8/ledger-v8.d.ts:2996`, alongside `firstFree` at line
   2982) and `ledger.DustLocalState.commitmentTreeRoot()` /
   `generatingTreeRoot()` (`ledger-v8.d.ts:1596,1601`)** are the primitives that make verification
   possible at all: the wallet's own local state can already report the Merkle root it believes
   it has reached, with zero new ledger-crate work. Nothing in the wallet SDK currently reads
   these properties (confirmed by grep — see §2).

---

## 2. What the wallet consumes from the indexer today

Grepped `packages/indexer-client/src/graphql/subscriptions/*.ts` (the literal GraphQL documents
sent over the wire):

- `ZswapEvents.ts:16-28` — subscribes to `zswapLedgerEvents(id)`, selecting only
  `{ id, raw, protocolVersion, maxId }`.
- `DustLedgerEvents.ts:16-28` — `dustLedgerEvents(id)`, selecting `{ type: __typename, id, raw, maxId }`.
- `UnshieldedTransactions.ts` (same directory) — analogous shape keyed by address.

None of these select `block`, `zswapMerkleTreeRoot`, or any Merkle-tree field, even though the
indexer schema has them. Confirmed by grep: `applyCollapsedUpdate` is **defined but never called**
anywhere in the wallet SDK (`shielded-wallet/src/v1/CoreWallet.ts:148-151` is the only hit for that
identifier in the whole repo) — the wallet-side machinery to fold a `MerkleTreeCollapsedUpdate`
into local state exists and is exercised by the ledger crate, but the sync loop never fetches one.

**What the indexer already exposes but the wallet never asks for**
(`indexer-api/graphql/schema-v4.graphql`):

- `type Block { zswapMerkleTreeRoot: HexEncoded!, zswapEndIndex: Int!, dustCommitmentMerkleTreeRoot: HexEncoded @beta, dustCommitmentEndIndex: Int! @beta, dustGenerationMerkleTreeRoot: HexEncoded @beta, dustGenerationEndIndex: Int! @beta, ... }` — lines 40-110.
- `Query.block(offset: BlockOffset)` — line 1254 — the "give me a committed root as of height/hash" query already exists at block granularity.
- `Query.zswapMerkleTreeCollapsedUpdate(startIndex, endIndex)` / `dustCommitmentMerkleTreeUpdate` / `dustGenerationMerkleTreeUpdate` — lines 1258, 1284, 1288 — the fold-catch-up primitive the ledger crate already supports client-side.

**Can the wallet verify against data it already receives, or does it need something new?**
Mixed answer, and this is the load-bearing finding of this angle:

- The **committed roots themselves** are already served (`Block.zswapMerkleTreeRoot` etc.) — no
  new indexer *data* is needed for zswap/dust commitment-tree verification in principle.
- But the wallet's sync cursor (`appliedIndex`/`id` on `zswapLedgerEvents`/`dustLedgerEvents`) is
  an **event-stream sequence number**, not a block height/hash. There is currently **no field or
  query that maps "event id N" → "the block (or even just the height) that produced it."**
  Confirmed at the domain layer: `indexer-api/src/domain/ledger_event.rs:18-32` — the `LedgerEvent`
  Rust struct carries only `{ id, raw, attributes, max_id, protocol_version }`, no block
  reference, and the GraphQL `type ZswapLedgerEvent` mirrors this exactly
  (`schema-v4.graphql:2482-2499`). So today a restoring wallet has an `appliedIndex` but no way to
  ask "what was the committed root when I reached that point" — **this is exactly the indexer
  gap**, and it is a real, if small, backend change (see §3), not solvable by a wallet-only fix.
- For **unshielded** wallets there is no Merkle tree at all (a UTXO ledger, not zswap/dust) — so
  "verification" there is necessarily a different shape: comparing the wallet's locally-tracked
  UTXO set against the indexer's authoritative view as of a block. No existing query does this
  (`grep -i utxo` over the schema turns up only per-transaction `unshieldedCreatedOutputs`/
  `unshieldedSpentOutputs`, never a point-in-time UTXO-set snapshot by address) — a genuinely new
  query is needed here, not just a field addition (see §3).

---

## 3. Indexer gap — sketch of the new surface

Grounded in two real precedents in the same file:

1. **`Transaction` already carries a reverse block reference as a matter of schema convention**:
   `interface Transaction { ..., block: Block! }` (`schema-v4.graphql:2104-2109`), implemented
   identically on `RegularTransaction`, `SystemTransaction`, `BridgeClaimTransaction`
   (lines 178, 1513, 2038 resp.). Adding `block: Block!` to `ZswapLedgerEvent`/`DustLedgerEvent` is
   the same pattern one level down the object graph, not a new idiom.
2. **The join path already exists at the storage layer, no migration needed.** Postgres schema:
   `ledger_events.transaction_id REFERENCES transactions(id)`
   (`indexer-common/migrations/postgres/001_initial.sql:108`), `transactions.block_id REFERENCES
   blocks(id)` (`.../001_initial.sql:35`), and — more precisely still —
   `regular_transactions` already stores the **exact per-transaction** anchor fields:
   `zswap_merkle_tree_root`, `zswap_start_index`, `zswap_end_index`,
   `dust_commitment_start_index`, `dust_commitment_end_index`, `dust_generation_start_index`,
   `dust_generation_end_index` (`.../001_initial.sql:47-59`). A ledger event's transaction already
   has this row; the anchor is finer-grained than the per-block one and requires **zero new
   columns**, only a new resolver that follows the existing FK chain
   `ledger_events → transactions → regular_transactions`.

### Sketch: new field on the ledger-event types (minimal-diff path)

```graphql
# schema-v4.graphql — extend the existing event types, same shape as Transaction.block
type ZswapLedgerEvent {
  id: Int!
  raw: HexEncoded!
  maxId: Int!
  protocolVersion: Int!
  """
  The committed Merkle-tree anchor as of the transaction that emitted this event: the tree's
  end index (exclusive) and root immediately after this event was applied on-chain. Lets a
  restoring wallet verify a locally-reconstructed root against the indexer's own committed
  value without re-deriving it from a full block.
  """
  zswapAnchor: TreeAnchor!
}

type DustLedgerEvent {
  # ...existing fields...
  dustCommitmentAnchor: TreeAnchor! @beta
  dustGenerationAnchor: TreeAnchor! @beta
}

"""A committed Merkle-tree root and its end index, as of a specific transaction."""
type TreeAnchor {
  endIndex: Int!
  root: HexEncoded!
  block: Block!
}
```

Resolver sketch, following the exact idiom of `Block::contract_zswap_state`
(`indexer-api/src/infra/api/v4/block.rs:154-206`, a `#[ComplexObject]` async field resolver that
loads via `cx.get_storage::<S>()`) and `Query::block`
(`indexer-api/src/infra/api/v4/query.rs:71-102`, the `BlockOffset` lookup pattern):

```rust
// indexer-api/src/infra/api/v4/ledger_events.rs (new #[ComplexObject] impl on ZswapLedgerEvent)
async fn zswap_anchor(&self, cx: &Context<'_>) -> ApiResult<TreeAnchor<S>> {
    let storage = cx.get_storage::<S>();
    // New storage method: joins ledger_events -> transactions -> regular_transactions
    // on ledger_events.id == self.id, no new migration (columns at 001_initial.sql:50-52).
    let (root, end_index, block) = storage
        .get_zswap_anchor_for_ledger_event(self.id)
        .await
        .map_err_into_server_error(|| format!("get zswap anchor for event {}", self.id))?
        .some_or_server_error(|| format!("no anchor for ledger event {}", self.id))?;
    Ok(TreeAnchor { root: root.hex_encode(), end_index, block: block.into() })
}
```

This is additive on the wire (new field, `@beta` for the dust variants matching the existing
`@beta` convention on `dustCommitmentMerkleTreeRoot` etc. at `schema-v4.graphql:82-88`) and adds
one new `Storage` trait method plus its Postgres/SQLite implementations — no schema migration,
per §3's join-path finding.

### Sketch: new query for unshielded UTXO-set snapshot verification (genuinely new surface)

No existing precedent covers this; a new top-level query, following the `contract(address,
offset: BlockOffset)` shape at `schema-v4.graphql:1271` and `query.rs:260-302`:

```graphql
extend type Query {
  """
  The wallet's unshielded UTXO set as committed at the given block offset (or the latest block
  if omitted). Lets a restoring wallet diff a locally-serialized UTXO snapshot against the
  indexer's authoritative view without replaying the full transaction history.
  """
  unshieldedUtxos(address: HexEncoded!, offset: BlockOffset): [UnshieldedUtxo!]! @beta
}
```

This one is a real new capability, not a join — the indexer has no existing "point-in-time UTXO
set by address" projection (only per-transaction created/spent lists,
`schema-v4.graphql:2409,2413`), so it likely needs a new indexed materialized view or an
as-of-block replay, mirroring how `contract(address, offset)` already resolves
"as-of-block" (`query.rs:272-299`, `get_contract_action_by_address_as_of_block_height`).

### Caveat carried over from the indexer's own docs

`docs/testing.md:12-26` documents that the indexer's chain-indexer **already** recomputes and
hard-fails (`bail!`) on any zswap-root / full-ledger-state-root mismatch against the node, on
every block (`chain-indexer/src/application.rs:~404-420`) — so a wallet trusting
`zswapMerkleTreeRoot` is trusting a value the indexer itself treats as sacrosanct. The same doc
is explicit that **dust roots are computed, stored, and served but not cross-checked against the
node** (no node dust-root RPC exists) — so a wallet-side dust-anchor check is only as strong as
the indexer's own dust computation, not doubly guarded the way zswap is. This caveat belongs in
the PR description for either sketch above, and in UmbraDB's own trust-model writeup.

---

## 4. SDK gap — sketch of the new surface

Two additive layers, both slotting into the extension points identified in §1.

### (a) Stamp the snapshot: `SerializationCapability` extension

```ts
// packages/shielded-wallet/src/v1/Serialization.ts — additive field on SnapshotSchema (line 67)
const SnapshotSchema = Schema.Struct({
  publicKeys: Schema.Struct({ /* ...unchanged... */ }),
  state: HexedState(),
  protocolVersion: Schema.BigInt,
  offset: Schema.optional(Schema.BigInt),
  networkId: Schema.String,
  coinHashes: Schema.Record({ /* ...unchanged... */ }),
  // NEW — optional so old snapshots still decode:
  anchor: Schema.optional(Schema.Struct({
    zswapMerkleTreeRoot: Schema.String,   // from wallet.state.merkleTreeRoot (ledger-v8.d.ts, ZswapLocalState)
    zswapEndIndex: Schema.BigInt,
    blockHash: Schema.String,
    blockHeight: Schema.Number,
  })),
});
```

`serialize()`'s `buildSnapshot` (`Serialization.ts:85-93`) reads `w.state.merkleTreeRoot` — a
property that already exists on `ledger.ZswapLocalState` and is simply never read today — plus
the block anchor obtained from the new indexer field in §3 at the moment of the last applied
event. The dust variant is symmetric via `w.state.commitmentTreeRoot()` /
`generatingTreeRoot()` (`ledger-v8.d.ts:1596,1601`).

### (b) Verify before trusting: new static factory alongside `restore()`

```ts
// packages/shielded-wallet/src/ShieldedWallet.ts — new sibling to the existing
// `static restore(serializedState)` at line 238
static async restoreVerified(
  serializedState: TSerialized,
  indexerClientConnection: { indexerHttpUrl: string },
): Promise<CustomShieldedWalletImplementation> {
  const deserialized: CoreWallet = CustomShieldedWalletImplementation.allVariantsRecord()
    [V1Tag].variant.deserializeState(serializedState).pipe(Either.getOrThrow);

  const anchor = extractAnchor(serializedState); // reads the new optional `anchor` field
  if (anchor !== undefined) {
    // New indexer-client query — thin wrapper over §3's new `zswapAnchor` field / `block(offset)`
    const committed = await QueryRunner.runPromise(
      FetchBlockAnchor, // new query doc, e.g. `block(offset: { hash: $blockHash }) { zswapMerkleTreeRoot, zswapEndIndex }`
      { blockHash: anchor.blockHash },
      { url: indexerClientConnection.indexerHttpUrl },
    );
    if (committed.zswapMerkleTreeRoot !== anchor.zswapMerkleTreeRoot) {
      throw new SnapshotAnchorMismatchError(anchor, committed); // new WalletError variant
    }
  }
  // Anchor checked (or snapshot pre-dates anchoring) — safe to resume from here, same path
  // `restore()` already uses:
  return CustomShieldedWalletImplementation.startFirst(CustomShieldedWalletImplementation, deserialized);
}
```

This composes with the existing two-step restore-then-start flow demonstrated in
`wallet-integration-tests/test/serializationAndRestoration.integration.test.ts:81-90` without
changing it: callers swap `Wallet.restore(s)` for `await Wallet.restoreVerified(s, conn)`, then
call `.start(secretKeys)` exactly as before. No change to `Sync.ts`'s `resumeFrom` logic (§1,
extension point 3) is needed — verification is a gate in front of the existing resume path, not a
replacement for it.

### (c) `TransactionHistoryStorage` — already durable-backend-ready, no SDK change needed

`packages/abstractions/src/TransactionHistoryStorage.ts:215-216` defines
`TransactionHistoryStorage<T>` as `TransactionHistoryReader<T> & TransactionHistoryWriter<T>` — a
plain interface (`getAll`, `get`, `serialize`, `gotPending`, `gotFinalized`, `gotRejected`), with
**no assumption of in-memory storage baked in**. The facade only ever depends on this interface
(`facade/src/index.ts:52,535,779,1364,1389-1396`), constructed once via
`initParams.configuration.txHistoryStorage` (`facade/src/index.ts:523`) and injected by the
caller. `InMemoryTransactionHistoryStorage` (`packages/abstractions/src/InMemoryTransactionHistoryStorage.ts`)
is the only shipped implementation, but it is not privileged — UmbraDB's
`CheckpointStore`/`TemporalKV` interfaces
(`design/../../src/interfaces/{checkpoint-store,temporal-kv}.ts`, read directly for this
research — `CheckpointStore`'s own doc comment literally cites "periodic snapshots (e.g. wallet
sync state)" as its motivating use case) can implement `TransactionHistoryStorage<WalletEntry>`
today, with **zero SDK changes required** — this is not a gap, it is already the intended seam.
What IS missing on the SDK side is any equivalent pluggable-storage interface for the **wallet
state snapshot itself** (the `serialize()`/`restore()` string blob) — today that is just a bare
`string` the caller must persist themselves (`SerializationCapability<TWallet, TAux, string>`,
e.g. `shielded-wallet/src/v1/Serialization.ts:19-22`), with no analogous `SnapshotStorage`
interface at the facade level the way `TransactionHistoryStorage` exists for tx history. Adding
one (mirroring `TransactionHistoryStorage`'s reader/writer split) is the natural third SDK-side
addition, letting UmbraDB's `CheckpointStore` (content-addressed, chunked, integrity-verified on
`load()` — `src/interfaces/checkpoint-store.ts:137-172`) back both snapshot and tx-history
persistence through one facade constructor argument instead of only the latter.

---

## 5. Contribution mechanics

Both repos: `CONTRIBUTING.md` (`midnight-wallet/CONTRIBUTING.md`,
`midnight-indexer/CONTRIBUTING.md`) require a signed CLA (via CLA-assistant, in-PR;
`midnight-wallet/CONTRIBUTING.md:6-10`), a fork + feature branch, matching license header on new
files (Apache-2.0 boilerplate given verbatim in both files), unit + integration tests for new
functionality, no force-pushes to an open PR (`midnight-wallet/CONTRIBUTING.md:46-47`), and
standard maintainer code review. `midnight-wallet` additionally calls out **specification parity**:
changes affecting key derivation or address formatting must update
`packages/spec-reference` and regenerate its test vectors via `yarn workspace
@midnightntwrk/wallet-sdk-spec-reference run gen` (`midnight-wallet/CONTRIBUTING.md:56-60`) — not
applicable to this snapshot-anchor work, but worth knowing since it touches the same repo.

`midnight-indexer` additionally points at `docs/` maintainer guides
(`midnight-indexer/CONTRIBUTING.md:60-69`): `docs/architecture.md`, `docs/releasing.md`,
`docs/testing.md` (read in full for this research — the root-match-guard doc, §3 above),
`docs/updating-node-version.md`, `docs/upgrading-ledger.md`. Concretely for this PR: CI runs
`indexer-tests/tests/native_e2e.rs` against a real `midnightntwrk/midnight-node` container plus
postgres/nats via testcontainers (`docs/testing.md:30-52`) and asserts every query/subscription
returns byte-identical JSON to a collected reference stream — so a new `zswapAnchor` field or
`unshieldedUtxos` query would need to be woven into that e2e assertion set, plus the
`qa/tests/` TypeScript smoke/integration/e2e suite (`docs/testing.md:57-64`), which includes a
schema-introspection / deprecation-detection smoke test that a new-field PR must not trip.

---

## Sources (file:line)

- `midnight-wallet/packages/shielded-wallet/src/v1/Sync.ts:218-313`
- `midnight-wallet/packages/shielded-wallet/src/v1/Serialization.ts:66-120`
- `midnight-wallet/packages/shielded-wallet/src/v1/CoreWallet.ts:100-165`
- `midnight-wallet/packages/shielded-wallet/src/ShieldedWallet.ts:175-328`
- `midnight-wallet/packages/unshielded-wallet/src/v1/Sync.ts:52-237`
- `midnight-wallet/packages/unshielded-wallet/src/v1/Serialization.ts:19-90`
- `midnight-wallet/packages/unshielded-wallet/src/v1/SyncProgress.ts:13-61`
- `midnight-wallet/packages/dust-wallet/src/v1/Sync.ts:75-425`
- `midnight-wallet/packages/dust-wallet/src/v1/Serialization.ts:23-114`
- `midnight-wallet/packages/facade/src/index.ts:52,281-350,479-573,737-760,1389-1396`
- `midnight-wallet/packages/abstractions/src/TransactionHistoryStorage.ts:159-217`
- `midnight-wallet/packages/indexer-client/src/graphql/subscriptions/{ZswapEvents,DustLedgerEvents}.ts`
- `midnight-wallet/packages/wallet-integration-tests/test/serializationAndRestoration.integration.test.ts:44-90`
- `midnight-wallet/node_modules/@midnight-ntwrk/ledger-v8/ledger-v8.d.ts:1596,1601,2885 (applyCollapsedUpdate),2996 (merkleTreeRoot)`
- `midnight-wallet/CONTRIBUTING.md`
- `midnight-indexer/indexer-api/graphql/schema-v4.graphql:40-110,1098-1117,1250-1300,1921,2104-2109,2482-2499`
- `midnight-indexer/indexer-api/src/infra/api/v4/block.rs:31-206`
- `midnight-indexer/indexer-api/src/infra/api/v4/query.rs:64-131`
- `midnight-indexer/indexer-api/src/infra/api/v4/subscription/zswap_ledger_events.rs`
- `midnight-indexer/indexer-api/src/domain/ledger_event.rs:17-32`
- `midnight-indexer/indexer-common/migrations/postgres/001_initial.sql:33-64,106-118`
- `midnight-indexer/docs/testing.md` (full)
- `midnight-indexer/CONTRIBUTING.md`
- `UmbraDB/src/interfaces/checkpoint-store.ts:119-172`
- `UmbraDB/src/interfaces/temporal-kv.ts` (TransactionHistoryStorage-compatible read/write shape, cross-referenced for the durable-backend argument in §4c)
