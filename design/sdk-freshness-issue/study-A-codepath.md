# Study A — Code-path analysis: wallet-SDK sync completion trusts the indexer's self-reported tip

**Verdict: the gap is REAL.** Across all three wallet types, "synced / caught up to tip" is decided by
comparing the wallet's applied cursor to a *tip value the indexer reports about itself*
(`maxId` / `highestTransactionId`, ultimately `SELECT MAX(id) …` over the indexer's own tables). There is
**no** independent, network-/finality-sourced cross-check anywhere in the wallet's sync-completion path. The
node-RPC client that *does* understand GRANDPA finality is wired only to the transaction-submission path, and
is not imported by any sync code. GRANDPA finality *is* enforced — but by the indexer (server-side), which the
wallet trusts wholesale.

Provenance of everything below:
- SDK repo `midnight-wallet` @ `e744d994fc94d7770fbd2c802d7bd4480cce83db` (2026-07-16, PR #508).
- Indexer repo `midnight-indexer` @ `0775a15d15c51e430520343e26eabfc1fbd481bf` (2026-07-21, #1340).
- Package versions: facade `4.1.0`, shielded-wallet `3.0.2`, unshielded-wallet `3.1.0`, dust-wallet `4.2.0`,
  abstractions `2.1.0`, indexer-client `1.2.3`, node-client `1.1.3`.

All `file:line` citations are relative to the respective repo root.

---

## 1. The exact code path — what "synced" means

### 1a. The completion predicate (shared abstraction; used by shielded + dust)

`packages/abstractions/src/SyncProgress.ts`:

```ts
// lines 13-19
export interface SyncProgressData {
  readonly appliedIndex: bigint;
  readonly highestRelevantWalletIndex: bigint;
  readonly highestIndex: bigint;
  readonly highestRelevantIndex: bigint;
  readonly isConnected: boolean;
}

// lines 30-35 — THE completion criterion
export const SyncProgress: SyncProgressOps = {
  isCompleteWithin(data: SyncProgressData, maxGap: bigint = 50n): boolean {
    const applyLag = BigInt(Math.abs(Number(data.highestRelevantWalletIndex - data.appliedIndex)));
    return data.isConnected && applyLag <= maxGap;
  },
};

// lines 65-67
isStrictlyComplete(): boolean {
  return SyncProgress.isCompleteWithin(this, 0n);
},
```

So "complete" = `isConnected && |highestRelevantWalletIndex − appliedIndex| ≤ maxGap`. The only "tip" term is
`highestRelevantWalletIndex`. `isStrictlyComplete()` is the same with `maxGap = 0n`
(`SyncProgress.ts:65-67`). Nothing else enters the decision.

### 1b. Unshielded uses a byte-for-byte-equivalent private copy

`packages/unshielded-wallet/src/v1/SyncProgress.ts`:

```ts
// lines 13-17
export interface SyncProgressData {
  readonly appliedId: bigint;
  readonly highestTransactionId: bigint;
  readonly isConnected: boolean;
}
// lines 29-32
isCompleteWithin(data, maxGap = 50n) {
  const applyLag = BigInt(Math.abs(Number(data.highestTransactionId - data.appliedId)));
  return data.isConnected && applyLag <= maxGap;
}
// lines 53-55: isStrictlyComplete() => isCompleteWithin(this, 0n)
```

Same shape: `isConnected && |highestTransactionId − appliedId| ≤ maxGap`. The tip term is
`highestTransactionId`.

### 1c. Where the predicate is consumed (the sync gate)

- Facade aggregate: `packages/facade/src/index.ts:287-293`
  ```ts
  public get isSynced(): boolean {
    return (
      this.shielded.state.progress.isStrictlyComplete() &&
      this.dust.state.progress.isStrictlyComplete() &&
      this.unshielded.progress.isStrictlyComplete()
    );
  }
  ```
- Per-wallet `waitForSyncedState(allowedGap = 0n)`:
  - shielded `packages/shielded-wallet/src/ShieldedWallet.ts:310-313`
  - dust `packages/dust-wallet/src/DustWallet.ts:424-427`
  - unshielded `packages/unshielded-wallet/src/UnshieldedWallet.ts:341-344`
  each: `state.progress.isCompleteWithin(allowedGap)`.

The user-facing "is my wallet caught up?" answer is exactly `isCompleteWithin` / `isStrictlyComplete`,
whose only tip input is the indexer-reported value traced next.

### 1d. Where the tip term is set — from the indexer subscription payload

**Shielded** — `packages/shielded-wallet/src/v1/Sync.ts`, `applyUpdate`:
```ts
// line 292-293
const lastUpdate = wrappedUpdate.updates.at(-1)!;
const highestRelevantWalletIndex = BigInt(lastUpdate.maxId);
// line 304-308
const updatedState = CoreWallet.updateProgress(newState, {
  highestRelevantWalletIndex,
  appliedIndex: freshUpdates.length === 0 ? appliedIndex : BigInt(freshUpdates.at(-1)!.id),
  isConnected: true,
});
```
`maxId` is the `EventsSyncUpdate.maxId` decoded from the `zswapLedgerEvents` payload
(`Sync.ts:143-155`, `EventsSyncUpdatePayload.maxId`).

**Dust** — `packages/dust-wallet/src/v1/Sync.ts`, `applyUpdate`:
```ts
// line 330
const highestRelevantWalletIndex = BigInt(updates.at(-1)!.maxId);
// line 342-346 — same updateProgress shape
```
`maxId` is decoded from the `dustLedgerEvents` payload (`SyncEventsUpdateSchema`, `Sync.ts:161-165`).

**Unshielded** — `packages/unshielded-wallet/src/v1/Sync.ts`, `applyUpdate`:
```ts
// line 109-115
if (update.type === 'UnshieldedTransactionsProgress') {
  return Either.right(
    CoreWallet.updateProgress(state, {
      highestTransactionId: BigInt(update.highestTransactionId),
      isConnected: true,
    }),
  );
}
```
`highestTransactionId` comes from the `UnshieldedTransactionsProgress` message on the
`unshieldedTransactions` subscription.

**Pattern is identical across all three wallet types** (two share the abstraction; unshielded keeps an
equivalent private copy). In every case the tip is set *only* from a field the indexer put on the wire, and
only when a message is received.

### 1e. The tip is refreshed *only* by received messages — why withholding = false "synced"

The event subscriptions carry no separate "you are at tip" sentinel; `isConnected` and the tip are set only
when a message arrives (`packages/shielded-wallet/src/v1/Sync.ts:220-224`, and the identical comment in
`packages/dust-wallet/src/v1/Sync.ts:278-282`). The cursor resumes at `appliedIndex − 1n` and is inclusive, so
an already-caught-up wallet re-receives the boundary event, which refreshes `maxId` and flips
`isConnected = true` (`shielded Sync.ts:283-308`). Consequently, whatever `maxId` the indexer attaches to the
last delivered message *is* the wallet's belief about the chain tip. If that number is stale/understated, or
if the indexer simply stops delivering newer events after emitting a low `maxId`, the wallet converges to
`applyLag = 0` and reports **strictly complete** while behind.

---

## 2. Provenance of the "tip" value — it is the indexer's own DB maximum

### 2a. GraphQL surface consumed by the wallet (indexer-client)

- `packages/indexer-client/src/graphql/subscriptions/ZswapEvents.ts:19-26`
  `subscription ZswapEvents($id: Int){ zswapLedgerEvents(id:$id){ id raw protocolVersion maxId } }`
- `packages/indexer-client/src/graphql/subscriptions/DustLedgerEvents.ts:19-26`
  `dustLedgerEvents(id:$id){ type:__typename id raw maxId }`
- `packages/indexer-client/src/graphql/subscriptions/UnshieldedTransactions.ts:67-70`
  `... on UnshieldedTransactionsProgress { type:__typename highestTransactionId }`

### 2b. Indexer resolver + schema — `max_id`

`indexer-api/src/infra/api/v4/ledger_events.rs:24-55` defines `ZswapLedgerEvent { id, raw, max_id, protocol_version }`,
with the doc comment "**The maximum ID of all zswap ledger events**" (`:31-32`) and `max_id: ledger_event.max_id`
in the conversion (`:47`). The dust event interface is the same (`:60-64`, `:89/98/110/118`).

The subscription resolver `indexer-api/src/infra/api/v4/subscription/zswap_ledger_events.rs:47-111` streams
stored events (`storage.get_ledger_events(...)`, `:68-70`) and yields `ledger_event.try_into()` — the `max_id`
attached is whatever storage computed; there is no consensus/finality field on the wire.

**The `max_id` is a plain `MAX(id)` over the indexer's own table**, `indexer-api/src/infra/storage/ledger_events.rs:87-100`:
```sql
SELECT
    ledger_events.id, ledger_events.raw, ledger_events.attributes,
    (SELECT MAX(id) FROM ledger_events WHERE grouping = $1) AS max_id,
    transactions.protocol_version
FROM ledger_events
INNER JOIN transactions ON transactions.id = ledger_events.transaction_id
WHERE ledger_events.grouping = $1 AND ledger_events.id >= $2
ORDER BY ledger_events.id LIMIT $3
```
(also at `:58` for the by-transaction-id variant). So the "tip" the wallet trusts is: *the highest event id
this indexer instance currently has in its own `ledger_events` table.* Nothing binds that number to the node,
to consensus, or to a finality proof at the point of delivery.

### 2c. Indexer resolver + schema — `highest_transaction_id` (unshielded)

`indexer-api/src/infra/api/v4/subscription/unshielded.rs:64-69` defines
`UnshieldedTransactionsProgress { highest_transaction_id }`, doc "**The highest transaction ID of all currently
known transactions for a subscribed address**". The resolver loop (`:285-307`) polls
`storage.get_highest_transaction_id_for_unshielded_address(address)` and yields it as the progress message.
That query is again a `MAX` over the indexer's own tables,
`indexer-api/src/infra/storage/transaction.rs:522-544`:
```sql
SELECT MAX(tx_id) FROM (
  SELECT MAX(creating_transaction_id) AS tx_id FROM unshielded_utxos WHERE owner = $1
  UNION ...
  SELECT MAX(spending_transaction_id)         FROM unshielded_utxos WHERE owner = $1
) ...
```

**Conclusion for §2:** for all three wallet types the completion tip is the indexer's *self-reported* maximum
event/transaction id, sourced from `MAX(...)` over its own database, delivered over a single WS/HTTP endpoint,
with no node/consensus/finality signal accompanying it.

---

## 3. Is there ANY finality / node-tip reconciliation in the sync path? — No.

### 3a. Finality exists in the codebase — but on the *submission* path only

`packages/node-client` *does* speak to the node and understands GRANDPA finality:
- `packages/node-client/src/effect/PolkadotNodeClient.ts:223-232` handles `status.isFinalized` → emits
  `SubmissionEvent.Finalized`.
- `packages/facade/src/index.ts:472-473` — the default submission service "uses Node RPC connection";
  `:780` `submitTransaction(tx, 'Finalized')`.

But that client's **entire public surface is submission**, `packages/node-client/src/effect/NodeClient.ts:18-56`:
`getGenesisTransactions`, `sendMidnightTransaction`, `sendMidnightTransactionAndWait`. There is **no**
`getHeader` / `getFinalizedHead` / chain-tip / block-height query.

And it is **not imported by any sync code**: grep for `node-client|NodeClient|PolkadotNodeClient` across
`packages/facade/src`, `packages/shielded-wallet/src`, `packages/dust-wallet/src`,
`packages/unshielded-wallet/src` returns nothing. The sync services take only indexer URLs
(`indexerHttpUrl` / `indexerWsUrl`, e.g. `facade/src/index.ts:340-341`, shielded `Sync.ts:195-217`).

### 3b. No RPC tip primitives anywhere in wallet source

Grep for `chain_getHeader | chain_getFinalizedHead | getFinalizedHead | subscribeFinalized | chainHead`
across `packages/**/*.ts` matches **only** vendored `@types/node` HTTP typings — zero hits in first-party
source. The dust wallet's `blockData()` (`dust-wallet/src/v1/Sync.ts:207-231`) fetches a block hash/height, but
via the **indexer** (`indexerSyncService.queryClient()`), not the node — so it is not an independent cross-check
either, and in any case it is not consulted by `isCompleteWithin`.

### 3c. The finality that exists is *at the trust boundary*, not at the client

For completeness (and to pre-empt the "but the indexer only indexes finalized blocks" objection): the indexer's
ingestion pipeline **does** follow GRANDPA-finalized blocks —
`chain-indexer/src/infra/subxt_node.rs:64-67` (`FINALIZATION_SAFETY_MARGIN = 400`, "One GRANDPA session worth of
blocks"), `:116` `subscribe_finalized_blocks`, `:291` `finalized_blocks`; `chain-indexer/src/application.rs:175`
("highest finalized block on node"), `:292` `node.finalized_blocks(highest_block)`. This is exactly the point:
**finality is verified by the indexer (the server), and the wallet trusts that verification wholesale.** A
compromised/malicious indexer, or a MITM on the wallet's single indexer endpoint, can report a `max_id` /
`highest_transaction_id` below the true finalized maximum (or stop emitting newer events) and the wallet has no
independent signal to contradict it. The client performs no finality check of its own.

---

## 4. Scope

- **Wallet types:** all three — shielded (`3.0.2`), unshielded (`3.1.0`), dust (`4.2.0`) — plus the shared
  `abstractions` (`2.1.0`) and the `facade` (`4.1.0`) aggregate `isSynced`. Two use the shared predicate; the
  unshielded copy is semantically identical.
- **Indexer API:** the `v4` GraphQL surface (`indexer-client` `1.2.3` ↔ `midnight-indexer` `indexer-api/.../v4`).
- **Live-sync AND restore-then-catch-up:** the completion criterion is the *same* object in both cases. On
  restore, `appliedIndex`/`appliedId` is seeded from the serialized cursor and the identical
  `|tip − applied| ≤ maxGap` comparison decides "caught up" (resume cursor `appliedIndex − 1n`, shielded
  `Sync.ts:218-230`, dust `Sync.ts:274-288`). A restored wallet pointed at a stale/malicious indexer will
  declare itself synced at whatever `maxId` that indexer emits — the restore path has no extra safeguard.
- **Default gaps:** `isStrictlyComplete()` uses `maxGap = 0n`; `waitForSyncedState()` defaults `allowedGap = 0n`;
  `isCompleteWithin` default `50n`. All compare solely to the indexer's number.
- **`isConnected` is not a freshness guarantee:** it means "≥1 event/progress message received"
  (`shielded Sync.ts:307`, unshielded `Sync.ts:113`), not "the endpoint is honest or current."

---

## 5. Minimal correct fix (sketch, against the real code)

Goal: make the sync-completion criterion depend on a **network-obtained, finality-verified tip** that is
*independent of the indexer's self-report*, so a stale/malicious/colluding indexer (or MITM) cannot drive the
wallet into a false "synced" state.

**Step 1 — give the wallet an independent finalized-tip source.** Extend `node-client` (which already holds the
node RPC connection, `PolkadotNodeClient.ts`) with a read primitive it currently lacks — a finalized head/height
query, e.g. `chain_getFinalizedHead` + `chain_getHeader` → finalized block **height**, or (stronger) ingestion
of GRANDPA finality proofs. Expose `NodeClient.getFinalizedTip(): Effect<{ height: bigint; hash: string }>`.
This is the load-bearing addition: today `node-client`'s surface is submission-only
(`NodeClient.ts:18-56`).

**Step 2 — carry a block-height anchor through the sync stream.** The wallet must be able to map "my applied
position" to a block height to compare against the node. The unshielded subscription already selects
`transaction.block.height` (`UnshieldedTransactions.ts:28-31`); the zswap/dust ledger-event streams key on
event id only, so add `block { height }` to those event payloads (indexer `SimpleObject`s already have the block
linkage) and thread a `highestAppliedBlockHeight` into `SyncProgressData`.

**Step 3 — reconcile in `isCompleteWithin`.** Change the criterion in
`packages/abstractions/src/SyncProgress.ts:30-35` (and the unshielded twin
`packages/unshielded-wallet/src/v1/SyncProgress.ts:29-32`) from a pure indexer-delta to a two-part check:

```ts
isCompleteWithin(data, maxGap = 50n): boolean {
  const applyLag = abs(data.highestRelevantWalletIndex - data.appliedIndex);
  const caughtUpToIndexer = data.isConnected && applyLag <= maxGap;
  // NEW: the indexer's delivered position must reach the independently-obtained
  // finalized tip (minus a small finality/indexing margin). If the node says the
  // finalized height is H but the wallet's applied/available events only reach
  // height h << H, the wallet is NOT synced — the indexer is behind or withholding.
  const reachesFinalizedTip =
    data.highestAppliedBlockHeight >= data.networkFinalizedHeight - FINALITY_MARGIN;
  return caughtUpToIndexer && reachesFinalizedTip;
}
```

where `networkFinalizedHeight` comes from `NodeClient.getFinalizedTip()` (Step 1), refreshed on a timer
independent of the indexer stream, and `FINALITY_MARGIN` mirrors the indexer's ingestion lag budget
(cf. `chain-indexer FINALIZATION_SAFETY_MARGIN = 400`).

**Minimal variant (no protocol changes, if a node RPC is unavailable):** cross-check the indexer's
self-reported tip against **≥2 independent indexer endpoints** and/or a node `chain_getHeader` height, and treat
divergence beyond a bound as "not synced / possible withholding" rather than "synced." This is weaker than
node-anchored finality but removes the single-endpoint trust that is the core of the gap.

**Net effect:** `FacadeState.isSynced` (`facade/src/index.ts:287-293`) and every `waitForSyncedState` stop
being satisfiable by an indexer that merely *claims* a low `maxId`; the wallet only declares "caught up" once
its applied position reaches a tip it verified against the network's finality, not the indexer's word.

---

## Appendix — single most load-bearing lines

- Completion criterion (shielded+dust): `packages/abstractions/src/SyncProgress.ts:31-33`.
- Tip set from indexer `maxId` (shielded): `packages/shielded-wallet/src/v1/Sync.ts:293`.
- Tip's ultimate origin (indexer self-`MAX`): `indexer-api/src/infra/storage/ledger_events.rs:92`.
- Absence of node cross-check: `node-client` surface is submission-only
  (`packages/node-client/src/effect/NodeClient.ts:18-56`) and unimported by any sync module.
