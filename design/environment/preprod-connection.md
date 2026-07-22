# Preprod connection — endpoints, wallet, faucet

Runtime facts for syncing a Midnight wallet against the **public preprod** network and funding it.
Scraped from docs.midnight.network (via scrapling) + the wallet SDK source, and verified live
2026-07-21.

## Public preprod endpoints (all verified live)

| Service | URL | Check |
|---|---|---|
| Node RPC (HTTP) | `https://rpc.preprod.midnight.network/` | `system_chain` → `"Midnight Preprod"` ✅ |
| Node RPC (WS) | `wss://rpc.preprod.midnight.network/` | live |
| Indexer GraphQL | `https://indexer.preprod.midnight.network/api/v4/graphql` | up (405 on GET = wants POST) ✅ |
| Indexer WS (sync) | `wss://indexer.preprod.midnight.network/api/v4/graphql/ws` | the channel the wallet actually syncs on |
| Proof server | **local** — `~/repos/midnight-ledger/target/release/midnight-proof-server` (port 6300) | built ✅ |

Pattern (from the wallet SDK `PreprodTestEnvironment`): a wallet syncs against the **public**
indexer + node, and uses a **local** proof-server. We do not need to run our own node to sync
preprod — the public node is live — though our from-source node build is available if we want a
self-hosted peer.

## Faucet (get tNIGHT)

- **USE THIS — up:** `https://midnight-tmnight-preprod.nethermind.dev/` (title "Midnight Faucet",
  HTTP 200). Paste an **unshielded** Bech32m address, click **Request tokens** → 1000 tNIGHT
  (~2 min). Then delegate tNIGHT → generate tDUST (the fee token).
- **Degraded — avoid:** `https://faucet.preprod.midnight.network/` (landing 200, but
  `/api/health` → 503).
- Rate limit: max requests per address; on hit, wait a few hours (docs `guides/acquire-tokens`).

## Our preprod wallet

- **Unshielded preprod address (vend tNIGHT here):**
  `mn_addr_preprod14plwqf5qymh879pskxyharf86plfj288ccvklaa74nqsha5f2p3szaxvvc`
- Address bytes (hex): `a87ee0268026ee7f1430b1897e8d27d07e9928e7c6196ff7beacc10bf6895063`
- **Derivation:** BIP32 `m/44'/2400'/0'/0/0` (role 0 = NightExternal) → `ledger-v8`
  `signatureVerifyingKey`→`addressFromKey` → Bech32m HRP `mn_addr_preprod`. Verified byte-for-byte
  against the SDK's own `UnshieldedAddress`/`MidnightBech32m.encode('preprod', …)` encoder
  (`MATCH_sdk = true`). Script: `~/repos/midnight-wallet/derive-preprod-address.mjs`.
- **Seed:** saved at `~/.midnight-preprod-wallet.seed` (600 perms, hex). Test-only wallet
  (preprod tNIGHT/tDUST, no real value), but keep the seed — it's needed to sync/spend and for the
  Sprint 7 conformance run. NOT committed anywhere.

## Sync cost (CORRECTED — no block-height "birthday" for the unshielded wallet)

Original assumption (a block-height "birthday" to skip genesis rescan) was WRONG for the unshielded
wallet. Verified by an actual preprod sync (~1.3s, observed the 1000 tNIGHT): the unshielded sync
subscribes to `UnshieldedTransactions.run({ address, transactionId })` — a per-address, transaction-id
cursor, NOT a block scan. The indexer resolves directly to the few transactions touching our address,
so there is NO genesis-rescan cost regardless of chain tip height, and no birthday config field exists
for this wallet type. Fast by construction.

A viewing-key/merkle-tree scan "birthday-like" concern MAY still apply to the SHIELDED and DUST wallets
(not exercised here, since the funded balance is on the unshielded address). Revisit if/when shielded or
dust state is synced. Preprod tip is still readable via `chain_getHeader` → `result.number` (hex).
